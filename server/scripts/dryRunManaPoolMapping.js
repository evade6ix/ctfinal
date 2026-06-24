import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const LIMIT = 5;

const cardTraderApi = axios.create({
  baseURL: "https://api.cardtrader.com/api/v2",
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${CARDTRADER_TOKEN}`,
    Accept: "application/json",
  },
});

const manaPoolApi = axios.create({
  baseURL: MANAPOOL_API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-ManaPool-Email": MANAPOOL_EMAIL,
    "X-ManaPool-Access-Token": MANAPOOL_ACCESS_TOKEN,
  },
});

function summarizeItem(item) {
  return [
    item.name || "Unnamed",
    item.setCode ? `Set: ${item.setCode}` : null,
    item.condition || null,
    item.isFoil ? "Foil" : "Nonfoil",
  ]
    .filter(Boolean)
    .join(" | ");
}

function findValueDeep(obj, possibleKeys) {
  if (!obj || typeof obj !== "object") return null;

  for (const key of possibleKeys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findValueDeep(item, possibleKeys);
      if (found !== null && found !== undefined) return found;
    }
  } else {
    for (const value of Object.values(obj)) {
      const found = findValueDeep(value, possibleKeys);
      if (found !== null && found !== undefined) return found;
    }
  }

  return null;
}

function normalizeArrayResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (data && typeof data === "object") return [data];
  return [];
}

async function fetchCardTraderBlueprintById(blueprintId) {
  // CardTrader does not have a simple guaranteed single-blueprint-by-id endpoint
  // in the sell guide, so this tries lightweight likely endpoints first.
  const candidates = [
    `/blueprints/${blueprintId}`,
    `/blueprints?ids=${blueprintId}`,
    `/blueprints?ids[]=${blueprintId}`,
    `/blueprints?blueprint_ids=${blueprintId}`,
  ];

  const failures = [];

  for (const url of candidates) {
    try {
      const res = await cardTraderApi.get(url);
      const arr = normalizeArrayResponse(res.data);
      const exact =
        arr.find((x) => String(x.id) === String(blueprintId)) || arr[0];

      if (exact) {
        return {
          sourceUrl: url,
          blueprint: exact,
        };
      }
    } catch (err) {
      failures.push({
        url,
        status: err.response?.status,
        message: err.response?.data || err.message,
      });
    }
  }

  return {
    sourceUrl: null,
    blueprint: null,
    failures,
  };
}

async function searchManaPoolByScryfallId(scryfallId) {
  const res = await manaPoolApi.get("/products/singles", {
    params: {
      scryfall_ids: [scryfallId],
      languages: ["EN"],
    },
  });

  return res.data;
}

async function searchManaPoolByTcgplayerId(tcgplayerId) {
  const res = await manaPoolApi.get("/products/singles", {
    params: {
      tcgplayer_ids: [Number(tcgplayerId)],
      languages: ["EN"],
    },
  });

  return res.data;
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing in .env");
    process.exit(1);
  }

  if (!CARDTRADER_TOKEN) {
    console.error("❌ CARDTRADER_TOKEN missing in .env");
    process.exit(1);
  }

  if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
    console.error("❌ MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN missing in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const inventoryCollection = mongoose.connection.collection("inventoryitems");

  const items = await inventoryCollection
    .find({ blueprintId: { $exists: true, $ne: null } })
    .sort({ updatedAt: -1 })
    .limit(LIMIT)
    .toArray();

  console.log(`\n🔎 Dry-running mapping for ${items.length} inventoryItems...\n`);

  for (const item of items) {
    const summary = summarizeItem(item);
    console.log("========================================");
    console.log(`Card: ${summary}`);
    console.log(`Inventory ID: ${item._id}`);
    console.log(`CardTrader blueprintId: ${item.blueprintId}`);

    const ctResult = await fetchCardTraderBlueprintById(item.blueprintId);

    if (!ctResult.blueprint) {
      console.log("❌ Could not fetch CardTrader blueprint by ID.");
      console.log("Tried endpoints:");
      console.log(JSON.stringify(ctResult.failures, null, 2));
      console.log("");
      continue;
    }

    console.log(`✅ CardTrader blueprint fetched via ${ctResult.sourceUrl}`);

    const scryfallId = findValueDeep(ctResult.blueprint, [
      "scryfall_id",
      "scryfallId",
    ]);

    const tcgplayerId = findValueDeep(ctResult.blueprint, [
      "tcgplayer_id",
      "tcgplayerId",
      "tcgplayer_product_id",
      "tcgplayerProductId",
    ]);

    console.log("Detected identifiers:");
    console.log({
      scryfallId,
      tcgplayerId,
    });

    if (!scryfallId && !tcgplayerId) {
      console.log("❌ Blueprint did not expose scryfall_id or tcgplayer_id.");
      console.log("");
      continue;
    }

    try {
      let manaPoolData = null;

      if (scryfallId) {
        manaPoolData = await searchManaPoolByScryfallId(scryfallId);
        console.log("✅ Mana Pool lookup by Scryfall ID succeeded.");
      } else if (tcgplayerId) {
        manaPoolData = await searchManaPoolByTcgplayerId(tcgplayerId);
        console.log("✅ Mana Pool lookup by TCGPlayer Product ID succeeded.");
      }

      const products = normalizeArrayResponse(manaPoolData);
      console.log(`Mana Pool returned ${products.length} product/result object(s).`);

      const preview = products.slice(0, 3).map((p) => ({
        product_id: p.id || p.product_id || p.productId,
        name: p.name || p.product_name || p.title,
        tcgplayer_id:
          p.tcgplayer_id || p.tcgplayerId || p.tcgplayer_product_id,
        tcgplayer_sku_id:
          p.tcgplayer_sku_id ||
          p.tcgplayerSkuId ||
          p.tcgplayer_sku ||
          p.tcgplayerSku,
        condition: p.condition || p.condition_name,
        finish: p.finish || p.foil || p.is_foil,
      }));

      console.log("Mana Pool preview:");
      console.log(JSON.stringify(preview, null, 2));
    } catch (err) {
      console.log("❌ Mana Pool lookup failed:");
      console.log({
        status: err.response?.status,
        data: err.response?.data,
        message: err.message,
      });
    }

    console.log("");
  }

  console.log("========================================");
  console.log("✅ Dry run complete. Nothing was changed.");
  console.log("========================================");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("❌ Dry run failed:", err.response?.data || err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});