import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

// Fetch your entire CardTrader stock using the official inventory export
// API: GET /products/export
async function fetchAllProducts(client) {
  console.log("→ Calling CardTrader /products/export …");

  const res = await client.get("/products/export", {
    // This call can be slow on large inventories (docs say several seconds),
    // so give it a generous timeout.
    timeout: 180000
  });

  const data = res.data;

  if (Array.isArray(data)) {
    console.log(`✅ /products/export returned ${data.length} products`);
    return data;
  }

  console.warn(
    "⚠️ Unexpected /products/export response shape, keys:",
    Object.keys(data)
  );
  return [];
}

// Map a CardTrader Product -> our InventoryItem fields
// Product object doc: id, name_en, quantity, price_cents, price_currency,
// game_id, blueprint_id, properties_hash, user_id, graded, tag, user_data_field
function mapProductToInventoryFields(prod) {
  const properties = prod.properties_hash || {};

  const cardTraderId = prod.id; // listing/article ID
  const name = prod.name_en || "";
  const quantity = prod.quantity ?? 0;

  // ✅ NEW: capture blueprint_id so we can backfill setCode later
  const blueprintId =
    typeof prod.blueprint_id !== "undefined" ? prod.blueprint_id : null;

  // price_cents may be a number or an object; handle both
  let price = 0;
  if (typeof prod.price_cents === "number") {
    price = prod.price_cents / 100;
  } else if (
    prod.price_cents &&
    typeof prod.price_cents === "object" &&
    typeof prod.price_cents.cents === "number"
  ) {
    price = prod.price_cents.cents / 100;
  }

  const condition =
    properties.condition ||
    properties.card_condition ||
    properties.cond ||
    "";

  const isFoil = Boolean(
    properties.mtg_foil ??
      properties.foil ??
      properties.reverse ??
      false
  );

  // We don't get expansion code directly here; will backfill via blueprintId
  const setCode = "";
  const game =
    typeof prod.game_id !== "undefined" ? String(prod.game_id) : "";

  return {
    cardTraderId,
    blueprintId,
    name,
    setCode,
    game,
    condition,
    isFoil,
    price,
    quantity
  };
}

async function main() {
  console.log("🔌 Connecting to Mongo…");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo");

  const client = ct();

  console.log("📄 Fetching CardTrader inventory via /products/export …");
  const products = await fetchAllProducts(client);

  if (!products.length) {
    console.log("⚠️ No products returned from CardTrader. Nothing to seed.");
    await mongoose.disconnect();
    console.log("🔌 Mongo disconnected.");
    return;
  }

  let totalUpserted = 0;

  for (const prod of products) {
    const mapped = mapProductToInventoryFields(prod);

    if (!mapped.cardTraderId) {
      continue; // skip if we couldn't find an ID
    }

    await InventoryItem.findOneAndUpdate(
      { cardTraderId: mapped.cardTraderId },
      {
        cardTraderId: mapped.cardTraderId,
        blueprintId: mapped.blueprintId,   // ✅ save blueprintId
        name: mapped.name,
        setCode: mapped.setCode,
        game: mapped.game,
        condition: mapped.condition,
        isFoil: mapped.isFoil,
        price: mapped.price,
        totalQuantity: mapped.quantity
        // locations/notes stay as-is; not touched here
      },
      { upsert: true, new: true }
    );

    totalUpserted++;
  }

  console.log(`🎉 Done seeding. Upserted/updated ${totalUpserted} inventory items.`);

  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected.");
}

main().catch((err) => {
  console.error("❌ Seed failed:", err?.response?.data || err.message);
  mongoose.disconnect().finally(() => process.exit(1));
});
