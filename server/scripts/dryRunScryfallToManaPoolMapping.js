import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const LIMIT = 5;

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-Mapping/1.0",
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

function normalizeArrayResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (data && typeof data === "object") return [data];
  return [];
}

function extractManaPoolProducts(data) {
  const products = normalizeArrayResponse(data);

  // Some APIs return a wrapper object with nested products/variants/prices.
  // This keeps the dry run flexible and prints what it can detect.
  if (products.length === 1 && products[0]?.products && Array.isArray(products[0].products)) {
    return products[0].products;
  }

  return products;
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

async function findScryfallCard(item) {
  // Best available from your current DB: exact name + set code.
  // This should usually find the right printing.
  const res = await scryfallApi.get("/cards/named", {
    params: {
      exact: item.name,
      set: item.setCode,
    },
  });

  return res.data;
}

async function searchManaPoolByTcgplayerId(tcgplayerId) {
  const params = new URLSearchParams();
  params.append("tcgplayer_ids", String(tcgplayerId));
  params.append("languages", "EN");

  const res = await manaPoolApi.get(`/products/singles?${params.toString()}`);
  return res.data;
}

async function searchManaPoolByScryfallId(scryfallId) {
  const params = new URLSearchParams();
  params.append("scryfall_ids", String(scryfallId));
  params.append("languages", "EN");

  const res = await manaPoolApi.get(`/products/singles?${params.toString()}`);
  return res.data;
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing in .env");
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
    .find({})
    .sort({ updatedAt: -1 })
    .limit(LIMIT)
    .toArray();

  console.log(`\n🔎 Dry-running Scryfall → Mana Pool mapping for ${items.length} inventoryItems...\n`);

  for (const item of items) {
    const summary = summarizeItem(item);

    console.log("========================================");
    console.log(`Card: ${summary}`);
    console.log(`Inventory ID: ${item._id}`);

    try {
      const scryfallCard = await findScryfallCard(item);

      console.log("✅ Scryfall match found:");
      console.log({
        name: scryfallCard.name,
        set: scryfallCard.set,
        collector_number: scryfallCard.collector_number,
        scryfall_id: scryfallCard.id,
        tcgplayer_id: scryfallCard.tcgplayer_id || null,
      });

      let manaPoolData = null;
      let lookupMethod = null;

      if (scryfallCard.tcgplayer_id) {
        lookupMethod = "tcgplayer_id";
        manaPoolData = await searchManaPoolByTcgplayerId(scryfallCard.tcgplayer_id);
      } else {
        lookupMethod = "scryfall_id";
        manaPoolData = await searchManaPoolByScryfallId(scryfallCard.id);
      }

      console.log(`✅ Mana Pool lookup succeeded by ${lookupMethod}`);

      const manaPoolProducts = extractManaPoolProducts(manaPoolData);

      console.log(`Mana Pool returned ${manaPoolProducts.length} result object(s).`);

      const preview = manaPoolProducts.slice(0, 5).map((p) => ({
        product_id: p.id || p.product_id || p.productId || null,
        name: p.name || p.product_name || p.title || null,
        set_code: p.set_code || p.setCode || p.expansion_code || null,
        tcgplayer_id:
          p.tcgplayer_id ||
          p.tcgplayerId ||
          p.tcgplayer_product_id ||
          p.tcgplayerProductId ||
          null,
        tcgplayer_sku_id:
          p.tcgplayer_sku_id ||
          p.tcgplayerSkuId ||
          p.tcgplayer_sku ||
          p.tcgplayerSku ||
          findValueDeep(p, [
            "tcgplayer_sku_id",
            "tcgplayerSkuId",
            "tcgplayer_sku",
            "tcgplayerSku",
          ]) ||
          null,
        condition: p.condition || p.condition_name || null,
        finish: p.finish || p.foil || p.is_foil || null,
      }));

      console.log("Mana Pool preview:");
      console.log(JSON.stringify(preview, null, 2));

      const detectedSku = findValueDeep(manaPoolData, [
        "tcgplayer_sku_id",
        "tcgplayerSkuId",
        "tcgplayer_sku",
        "tcgplayerSku",
      ]);

      if (detectedSku) {
        console.log(`✅ Possible TCGPlayer SKU detected: ${detectedSku}`);
      } else {
        console.log("⚠️ No TCGPlayer SKU detected in the response preview.");
      }
    } catch (err) {
      console.log("❌ Mapping failed:");
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