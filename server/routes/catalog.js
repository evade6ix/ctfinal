import express from "express";
import axios from "axios";

const router = express.Router();

const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

if (!TOKEN) {
  console.error("❌ CARDTRADER_TOKEN missing in .env");
}

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 20000,
  });
}

// =======================
// Tiny market-price cache
// =======================
const MARKET_TTL_MS = 30 * 1000; // 30 seconds
// key: blueprintId::condition -> { at, value }
const marketCache = new Map();

function normalizeCondition(value) {
  return (value || "").toString().trim().toUpperCase();
}

function listingIsZero(listing) {
  return (
    listing?.via_cardtrader_zero === true ||
    listing?.cardtrader_zero === true ||
    listing?.zero === true
  );
}

function listingCondition(listing) {
  return normalizeCondition(
    listing?.properties?.condition ||
      listing?.condition ||
      listing?.card_condition ||
      listing?.grading ||
      ""
  );
}
async function getMarketPriceForBlueprint(client, blueprintId) {
  const key = String(blueprintId);
  const now = Date.now();

  const cached = marketCache.get(key);
  if (cached && now - cached.at < MARKET_TTL_MS) {
    return cached.value;
  }

  try {
    const resp = await client.get("/marketplace/products", {
      params: {
        blueprint_id: blueprintId,
        language: "en",
      },
    });

    const data = resp.data || {};
    const arr = Array.isArray(data[String(blueprintId)])
      ? data[String(blueprintId)]
      : [];

    if (!arr.length) {
      marketCache.set(key, { at: now, value: null });
      return null;
    }

    const zeroOnly = arr.filter((x) => {
      if (!x || !x.price || x.price.cents == null) return false;
      return x.user?.can_sell_via_hub === true;
    });

    if (!zeroOnly.length) {
      marketCache.set(key, { at: now, value: null });
      return null;
    }

    const cheapest = zeroOnly
      .slice()
      .sort((a, b) => Number(a.price.cents) - Number(b.price.cents))[0];

    const value =
      cheapest && cheapest.price && cheapest.price.cents != null
        ? Number(cheapest.price.cents) / 100
        : null;

    marketCache.set(key, { at: now, value });
    return value;
  } catch (err) {
    console.error(
      "Error fetching ZERO EN market for blueprint",
      blueprintId,
      err?.response?.data || err.message
    );
    marketCache.set(key, { at: now, value: null });
    return null;
  }
}

// =======================
// GET /api/catalog/games
// =======================
router.get("/games", async (req, res) => {
  try {
    const client = ct();
    const { data } = await client.get("/games");

    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data && data.array)
      ? data.array
      : [];

    const games = arr.map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.display_name || g.displayName || g.name,
    }));

    res.json({ games });
  } catch (err) {
    const details = err.response?.data || err.message || String(err);
    console.error("Error fetching games from CardTrader:", details);
    res.status(500).json({
      error: "Failed to fetch games from CardTrader",
      details,
    });
  }
});

// =======================
// GET /api/catalog/sets?gameId=1
// =======================
router.get("/sets", async (req, res) => {
  const gameId = Number(req.query.gameId);

  if (!gameId) {
    return res.status(400).json({ error: "Missing or invalid gameId" });
  }

  try {
    const client = ct();
    const { data } = await client.get("/expansions");

    const expArr = Array.isArray(data)
      ? data
      : Array.isArray(data && data.expansions)
      ? data.expansions
      : [];

    const expansions = expArr.filter((exp) => exp.game_id === gameId);

    const sets = expansions.map((exp) => ({
      id: exp.id,
      code: exp.code,
      name: exp.name,
      gameId: exp.game_id,
    }));

    res.json({ sets });
  } catch (err) {
    console.error(
      "Error fetching sets from CardTrader:",
      err.response?.data || err.message
    );
    res.status(500).json({
      error: "Failed to fetch sets from CardTrader",
      details: err.response?.data || err.message,
    });
  }
});

// =======================
// POST /api/catalog/search
// Body: { gameId, setIds: [expansionId], query, page, pageSize, condition }
// Returns CardTrader blueprints WITH market price
// market = LOWEST ZERO ENGLISH listing for selected condition
// =======================
router.post("/search", async (req, res) => {
  let { gameId, setIds, query, page, pageSize } = req.body || {};

  gameId = Number(gameId);
  page = Number(page) || 1;
  pageSize = Number(pageSize) || 50;
  if (!Array.isArray(setIds)) setIds = [];
  const trimmedQuery = (query || "").toString().trim().toLowerCase();

  if (!gameId) {
    return res.status(400).json({ error: "Missing or invalid gameId" });
  }

  if (setIds.length === 0) {
    return res
      .status(400)
      .json({ error: "You must provide at least one set (expansion) id" });
  }

  try {
    const client = ct();

    const { data: expData } = await client.get("/expansions");
    const expArr = Array.isArray(expData)
      ? expData
      : Array.isArray(expData && expData.expansions)
      ? expData.expansions
      : [];

    const expansionsById = new Map(expArr.map((exp) => [exp.id, exp]));

    const allBlueprints = [];

    for (const expansionIdRaw of setIds) {
      const expansionId = Number(expansionIdRaw);
      if (!expansionId) continue;

      try {
        const { data } = await client.get("/blueprints/export", {
          params: { expansion_id: expansionId },
        });

        (data || []).forEach((bp) => {
          const exp = expansionsById.get(bp.expansion_id);
          allBlueprints.push({
  id: bp.id,
  name: bp.name,
  version: bp.version,

  // YGO / generic blueprint metadata
  rarity:
    bp.fixed_properties?.yugioh_rarity ||
    bp.fixed_properties?.rarity ||
    bp.fixed_properties?.mtg_rarity ||
    bp.version ||
    null,

  number:
    bp.fixed_properties?.collector_number ||
    null,

  gameId: bp.game_id,
  categoryId: bp.category_id,
  expansionId: bp.expansion_id,
  setCode: exp && exp.code,
  setName: exp && exp.name,
  scryfallId: bp.scryfall_id,
  tcgPlayerId: bp.tcg_player_id,
  cardMarketIds: bp.card_market_ids,
  imageUrl: bp.image_url,
});
        });
      } catch (err) {
        console.error(
          `Error fetching blueprints for expansion ${expansionId}:`,
          err.response?.data || err.message
        );
      }
    }

    let filtered = allBlueprints.filter((bp) => bp.gameId === gameId);

    if (trimmedQuery) {
      filtered = filtered.filter(
        (bp) => bp.name && bp.name.toLowerCase().includes(trimmedQuery)
      );
    }

    filtered.sort((a, b) => {
      if ((a.setCode || "") === (b.setCode || "")) {
        return (a.name || "").localeCompare(b.name || "");
      }
      return (a.setCode || "").localeCompare(b.setCode || "");
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const slice = filtered.slice(start, end);

    const items = await Promise.all(
  slice.map(async (bp) => {
    const market = await getMarketPriceForBlueprint(client, bp.id);

    let rarity = bp.rarity || bp.version || null;
let edition = null;
let finish = null;

    try {
      const resp = await client.get("/marketplace/products", {
        params: {
          blueprint_id: bp.id,
          language: "en",
        },
      });

      const arr = Array.isArray(resp.data[String(bp.id)])
        ? resp.data[String(bp.id)]
        : [];

      if (arr.length) {
        const first = arr[0];
        const p = first?.properties || {};

        rarity =
  bp.rarity ||
  bp.version ||
  p.yugioh_rarity ||
  p.rarity ||
  p.mtg_rarity ||
  null;

        edition =
          p.edition ||
          p.yugioh_edition ||
          null;

        finish =
          typeof p.foil === "boolean"
            ? p.foil
              ? "Foil"
              : null
            : p.finish ||
              p.foiling ||
              p.yugioh_foil ||
              null;
      }
    } catch (e) {
      // ignore — fallback to null
    }

    return {
      ...bp,
      market,
      rarity,
      edition,
      finish,
    };
  })
);

res.json({
      items,
      total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error(
      "Error searching CardTrader catalog:",
      err.response?.data || err.message
    );
    res.status(500).json({
      error: "Failed to search CardTrader catalog",
      details: err.response?.data || err.message,
    });
  }
});

export default router;