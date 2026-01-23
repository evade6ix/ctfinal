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

    // CardTrader is returning { array: [...] }
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.array)
      ? data.array
      : [];

    if (arr.length === 0) {
      console.warn("CardTrader /games had no array data.");
    }

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
  : Array.isArray(data?.expansions)
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
// Body: { gameId, setIds: [expansionId], query, page, pageSize }
// Returns CardTrader blueprints
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
    const { data: allExpansions } = await client.get("/expansions");
    const expansionsById = new Map(
      (allExpansions || []).map((exp) => [exp.id, exp])
    );

    const allBlueprints = [];

    // Loop through chosen expansions and hit /blueprints/export for each
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
      } catch (err) {
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
    const pageItems = filtered.slice(start, end);

    res.json({
      items: pageItems,
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
