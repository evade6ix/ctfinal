import express from "express";
import axios from "axios";
import { CatalogSetCache } from "../models/CatalogSetCache.js";

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
    timeout: 30000,
  });
}

const MARKET_TTL_MS = process.env.CATALOG_MARKET_CACHE_TTL_MS
  ? Number(process.env.CATALOG_MARKET_CACHE_TTL_MS)
  : 5 * 60 * 1000;

const SET_CACHE_TTL_MS = process.env.CATALOG_SET_CACHE_TTL_MS
  ? Number(process.env.CATALOG_SET_CACHE_TTL_MS)
  : 24 * 60 * 60 * 1000;

const marketCache = new Map();
let expansionsCache = { at: 0, data: [] };
const EXPANSIONS_TTL_MS = 60 * 60 * 1000;

function normalizeCondition(value) {
  return (value || "").toString().trim().toUpperCase();
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

async function getExpansions(client) {
  const now = Date.now();

  if (expansionsCache.data.length && now - expansionsCache.at < EXPANSIONS_TTL_MS) {
    return expansionsCache.data;
  }

  const { data } = await client.get("/expansions");
  const expArr = Array.isArray(data)
    ? data
    : Array.isArray(data && data.expansions)
    ? data.expansions
    : [];

  expansionsCache = { at: now, data: expArr };
  return expArr;
}

function normalizeBlueprint(bp, exp) {
  const fixed = bp.fixed_properties || {};

  return {
    id: bp.id,
    name: bp.name,
    version: bp.version,
    rarity:
      fixed.yugioh_rarity ||
      fixed.rarity ||
      fixed.mtg_rarity ||
      bp.version ||
      null,
    number: fixed.collector_number || null,
    gameId: bp.game_id,
    categoryId: bp.category_id,
    expansionId: bp.expansion_id,
    setCode: exp?.code || "",
    setName: exp?.name || "",
    scryfallId: bp.scryfall_id,
    tcgPlayerId: bp.tcg_player_id,
    cardMarketIds: bp.card_market_ids,
    imageUrl: bp.image_url,
  };
}

function isFreshCache(cacheDoc) {
  return (
    cacheDoc &&
    Array.isArray(cacheDoc.blueprints) &&
    cacheDoc.expiresAt &&
    new Date(cacheDoc.expiresAt).getTime() > Date.now()
  );
}

async function fetchAndCacheSet(client, gameId, expansionId, expansion) {
  const exp = expansion || { id: expansionId, code: "", name: "", game_id: gameId };

  const { data } = await client.get("/blueprints/export", {
    params: { expansion_id: expansionId },
  });

  const rawBlueprints = Array.isArray(data) ? data : [];
  const blueprints = rawBlueprints.map((bp) => normalizeBlueprint(bp, exp));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SET_CACHE_TTL_MS);

  const doc = await CatalogSetCache.findOneAndUpdate(
    { expansionId },
    {
      $set: {
        gameId,
        expansionId,
        setCode: exp.code || "",
        setName: exp.name || "",
        blueprintCount: blueprints.length,
        blueprints,
        fetchedAt: now,
        expiresAt,
      },
    },
    { upsert: true, new: true }
  ).lean();

  return { doc, cached: false };
}

async function getCachedSetOrFetch(client, gameId, expansionId, expansionsById, force = false) {
  const existing = !force
    ? await CatalogSetCache.findOne({ expansionId }).lean()
    : null;

  if (isFreshCache(existing)) {
    return { doc: existing, cached: true };
  }

  const expansion = expansionsById.get(expansionId) || null;
  return fetchAndCacheSet(client, gameId, expansionId, expansion);
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
    const expArr = await getExpansions(client);
    const expansions = expArr.filter((exp) => exp.game_id === gameId);

    const cachedSetIds = await CatalogSetCache.find({
      gameId,
      expiresAt: { $gt: new Date() },
    })
      .select("expansionId blueprintCount fetchedAt expiresAt")
      .lean();

    const cacheByExpansionId = new Map(
      cachedSetIds.map((doc) => [Number(doc.expansionId), doc])
    );

    const sets = expansions.map((exp) => {
      const cached = cacheByExpansionId.get(Number(exp.id));

      return {
        id: exp.id,
        code: exp.code,
        name: exp.name,
        gameId: exp.game_id,
        cached: !!cached,
        cachedBlueprintCount: cached?.blueprintCount || 0,
        cachedAt: cached?.fetchedAt || null,
        cacheExpiresAt: cached?.expiresAt || null,
      };
    });

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
// POST /api/catalog/cache-set
// Body: { gameId, setId, force }
// Fetches one set into Mongo so searches can read locally.
// =======================
router.post("/cache-set", async (req, res) => {
  let { gameId, setId, force } = req.body || {};
  gameId = Number(gameId);
  const expansionId = Number(setId);

  if (!gameId) {
    return res.status(400).json({ error: "Missing or invalid gameId" });
  }

  if (!Number.isFinite(expansionId) || expansionId <= 0) {
    return res.status(400).json({ error: "Missing or invalid setId" });
  }

  try {
    const client = ct();
    const expArr = await getExpansions(client);
    const expansionsById = new Map(expArr.map((exp) => [Number(exp.id), exp]));

    const startedAt = Date.now();
    const { doc, cached } = await getCachedSetOrFetch(
      client,
      gameId,
      expansionId,
      expansionsById,
      force === true
    );

    return res.json({
      ok: true,
      cached,
      setId: expansionId,
      setCode: doc?.setCode || "",
      setName: doc?.setName || "",
      blueprintCount: doc?.blueprintCount || 0,
      fetchedAt: doc?.fetchedAt || null,
      expiresAt: doc?.expiresAt || null,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(
      `Error caching catalog set ${expansionId}:`,
      err.response?.data || err.message
    );

    res.status(500).json({
      error: "Failed to cache catalog set",
      details: err.response?.data || err.message,
    });
  }
});

// =======================
// POST /api/catalog/search
// Body: { gameId, setIds: [expansionId], query, page, pageSize }
// Uses Mongo set cache first. Missing/expired sets are fetched and cached.
// =======================
router.post("/search", async (req, res) => {
  let { gameId, setIds, query, page, pageSize } = req.body || {};

  gameId = Number(gameId);
  page = Number(page) || 1;
  pageSize = Number(pageSize) || 50;
  if (!Array.isArray(setIds)) setIds = [];
  const normalizedSetIds = [...new Set(setIds.map(Number).filter(Boolean))];
  const trimmedQuery = (query || "").toString().trim().toLowerCase();

  if (!gameId) {
    return res.status(400).json({ error: "Missing or invalid gameId" });
  }

  if (normalizedSetIds.length === 0) {
    return res
      .status(400)
      .json({ error: "You must provide at least one set (expansion) id" });
  }

  try {
    const client = ct();
    const expArr = await getExpansions(client);
    const expansionsById = new Map(expArr.map((exp) => [Number(exp.id), exp]));
    const allBlueprints = [];
    const cacheReport = [];

    for (const expansionId of normalizedSetIds) {
      try {
        const { doc, cached } = await getCachedSetOrFetch(
          client,
          gameId,
          expansionId,
          expansionsById
        );

        if (doc?.blueprints?.length) {
          allBlueprints.push(...doc.blueprints);
        }

        cacheReport.push({
          setId: expansionId,
          cached,
          blueprintCount: doc?.blueprintCount || doc?.blueprints?.length || 0,
        });
      } catch (err) {
        console.error(
          `Error loading cached blueprints for expansion ${expansionId}:`,
          err.response?.data || err.message
        );
        cacheReport.push({
          setId: expansionId,
          cached: false,
          error: err.response?.data || err.message,
        });
      }
    }

    let filtered = allBlueprints.filter((bp) => Number(bp.gameId) === gameId);

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

        return {
          ...bp,
          market,
          rarity: bp.rarity || bp.version || null,
          edition: null,
          finish: null,
        };
      })
    );

    res.json({
      items,
      total,
      page,
      pageSize,
      cache: cacheReport,
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
