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
// key: blueprintId -> { at, value }
const marketCache = new Map<string, { at: number; value: number | null }>();

/**
 * Fetch cheapest listing price for a blueprint (any game).
 * Tries EN first, then falls back to any language.
 * Returns a number in your currency (e.g. 1.23) or null if none.
 */
async function getMarketPriceForBlueprint(
  client: ReturnType<typeof ct>,
  blueprintId: number | string
): Promise<number | null> {
  const key = String(blueprintId);
  const now = Date.now();

  const cached = marketCache.get(key);
  if (cached && now - cached.at < MARKET_TTL_MS) {
    return cached.value;
  }

  try {
    // 1) Try English listings first (what you originally had)
    let { data } = await client.get("/marketplace/products", {
      params: {
        blueprint_id: blueprintId,
        language: "en",
      },
    });

    let arr = data?.[key] || [];

    // 2) If no EN listings, retry without language filter (all languages)
    if (!Array.isArray(arr) || arr.length === 0) {
      const fallbackRes = await client.get("/marketplace/products", {
        params: {
          blueprint_id: blueprintId,
          // no language param -> all listings
        },
      });
      data = fallbackRes.data;
      arr = data?.[key] || [];
    }

    if (!Array.isArray(arr) || arr.length === 0) {
      marketCache.set(key, { at: now, value: null });
      return null;
    }

    const cheapest = arr
      .filter((x: any) => x?.price?.cents != null)
      .sort((a: any, b: any) => a.price.cents - b.price.cents)[0];

    const value =
      cheapest?.price?.cents != null
        ? Number(cheapest.price.cents) / 100
        : null;

    marketCache.set(key, { at: now, value });
    return value;
  } catch (err: any) {
    console.error(
      "Error fetching market for blueprint",
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

    console.log(
      "CardTrader /games raw response type:",
      typeof data,
      "isArray:",
      Array.isArray(data)
    );
    console.log("CardTrader /games raw response value:", data);

    // CardTrader is returning { array: [...] } in some environments
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.array)
      ? (data as any).array
      : [];

    if (arr.length === 0) {
      console.warn("CardTrader /games had no array data.");
    }

    const games = arr.map((g: any) => ({
      id: g.id,
      name: g.name,
      displayName: g.display_name || g.displayName || g.name,
    }));

    res.json({ games });
  } catch (err: any) {
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
// (expansions for a game)
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
      : Array.isArray((data as any)?.expansions)
      ? (data as any).expansions
      : [];

    const expansions = expArr.filter((exp: any) => exp.game_id === gameId);

    const sets = expansions.map((exp: any) => ({
      id: exp.id,
      code: exp.code,
      name: exp.name,
      gameId: exp.game_id,
    }));

    res.json({ sets });
  } catch (err: any) {
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
// Body: { gameId, setIds: [expansionId], query, page, pageSize }
// Returns CardTrader blueprints WITH market price
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

    // Pull expansions once so we can decorate results with set code/name
    const { data: expData } = await client.get("/expansions");
    const expArr = Array.isArray(expData)
      ? expData
      : Array.isArray((expData as any)?.expansions)
      ? (expData as any).expansions
      : [];

    const expansionsById = new Map<number, any>(
      expArr.map((exp: any) => [exp.id, exp])
    );

    const allBlueprints: any[] = [];

    // Loop through chosen expansions and hit /blueprints/export for each
    for (const expansionIdRaw of setIds) {
      const expansionId = Number(expansionIdRaw);
      if (!expansionId) continue;

      try {
        const { data } = await client.get("/blueprints/export", {
          params: { expansion_id: expansionId },
        });

        (data || []).forEach((bp: any) => {
          const exp = expansionsById.get(bp.expansion_id);
          allBlueprints.push({
            id: bp.id,
            name: bp.name,
            version: bp.version,
            gameId: bp.game_id,
            categoryId: bp.category_id,
            expansionId: bp.expansion_id,
            setCode: exp?.code,
            setName: exp?.name,
            scryfallId: bp.scryfall_id,
            tcgPlayerId: bp.tcg_player_id,
            cardMarketIds: bp.card_market_ids,
            imageUrl: bp.image_url,
          });
        });
      } catch (err: any) {
        console.error(
          `Error fetching blueprints for expansion ${expansionId}:`,
          err.response?.data || err.message
        );
      }
    }

    // Filter by gameId (extra safety)
    let filtered = allBlueprints.filter((bp) => bp.gameId === gameId);

    // Optional name filter
    if (trimmedQuery) {
      filtered = filtered.filter((bp) =>
        bp.name?.toLowerCase().includes(trimmedQuery)
      );
    }

    // Sort by set code then card name
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

    // Enrich page slice with market price (any game, not just Magic)
    const items = await Promise.all(
      slice.map(async (bp) => {
        const market = await getMarketPriceForBlueprint(client, bp.id);
        return {
          ...bp,
          market, // number | null
        };
      })
    );

    res.json({
      items,
      total,
      page,
      pageSize,
    });
  } catch (err: any) {
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
