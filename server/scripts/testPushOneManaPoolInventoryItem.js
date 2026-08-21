import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const TEST_INVENTORY_ITEM_ID =
  process.env.TEST_INVENTORY_ITEM_ID || "69fa3f7d6b0ac9e32c42a500";

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-TestPush/1.0",
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

function getQuantity(item) {
  if (typeof item.totalQuantity === "number") {
    return Math.max(0, item.totalQuantity);
  }

  if (Array.isArray(item.locations)) {
    return item.locations.reduce((sum, loc) => {
      const qty = typeof loc.quantity === "number" ? loc.quantity : 0;
      return sum + Math.max(0, qty);
    }, 0);
  }

  return 0;
}

function getPriceCents(item) {
  if (typeof item.priceCents === "number") return Math.round(item.priceCents);
  if (typeof item.price_cents === "number") return Math.round(item.price_cents);
  if (typeof item.price === "number") return Math.round(item.price * 100);
  return null;
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

  const item = await inventoryCollection.findOne({
    _id: new mongoose.Types.ObjectId(TEST_INVENTORY_ITEM_ID),
  });

  if (!item) {
    console.error(`❌ Inventory item not found: ${TEST_INVENTORY_ITEM_ID}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("========================================");
  console.log("LIVE TEST PUSH - ONE ITEM ONLY");
  console.log("========================================");
  console.log({
    inventoryItemId: item._id.toString(),
    name: item.name,
    setCode: item.setCode,
    condition: item.condition,
    isFoil: item.isFoil,
    price: item.price,
    totalQuantity: item.totalQuantity,
  });

  const quantity = getQuantity(item);
  const priceCents = getPriceCents(item);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new Error(`Invalid price cents: ${priceCents}`);
  }

  const scryfallCard = await findScryfallCard(item);

  if (!scryfallCard.tcgplayer_id) {
    throw new Error("Scryfall card has no tcgplayer_id");
  }

  console.log("✅ Scryfall matched:");
  console.log({
    name: scryfallCard.name,
    set: scryfallCard.set,
    collector_number: scryfallCard.collector_number,
    tcgplayer_id: scryfallCard.tcgplayer_id,
  });

  const manaPoolData = await searchManaPoolByTcgplayerId(
    scryfallCard.tcgplayer_id
  );

  const tcgplayerSku = findValueDeep(manaPoolData, [
    "tcgplayer_sku_id",
    "tcgplayerSkuId",
    "tcgplayer_sku",
    "tcgplayerSku",
  ]);

  if (!tcgplayerSku) {
    throw new Error("Mana Pool response did not include TCGPlayer SKU");
  }

  const payload = [
    {
      tcgplayer_sku: Number(tcgplayerSku),
      price_cents: priceCents,
      quantity,
      custom_external_id: `G3-INV-${item._id.toString()}-${conditionId}-${finishId}`,
    },
  ];

  console.log("Payload that WILL be sent:");
  console.log(JSON.stringify(payload, null, 2));

  console.log("\n⚠️ Sending ONE live item to Mana Pool now...");

  const response = await manaPoolApi.post("/seller/inventory/tcgsku", payload);

  console.log("\n✅ Mana Pool response:");
  console.log(JSON.stringify(response.data, null, 2));

  console.log("\n✅ Live one-item test complete.");

  await mongoose.disconnect();
  console.log("✅ Disconnected from MongoDB");
}

main().catch(async (err) => {
  console.error("❌ Live test push failed:");
  console.error({
    status: err.response?.status,
    data: err.response?.data,
    message: err.message,
  });

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});