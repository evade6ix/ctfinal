import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

async function main() {
  console.log("🔌 Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo.");

  const client = ct();

  // 1) Build a map: product.id -> mtg_card_colors
  console.log("📄 Fetching CardTrader inventory via /products/export …");
  const exportRes = await client.get("/products/export", {
    timeout: 180000,
  });

  const products = Array.isArray(exportRes.data) ? exportRes.data : [];
  console.log(`✅ /products/export returned ${products.length} products`);

  const colorMap = new Map(); // key: product.id, value: colors string

  for (const prod of products) {
    const gameId = prod.game_id;
    const props = prod.properties_hash || prod.properties || {};
    const colors = props.mtg_card_colors;

    if (gameId === 1 && typeof colors === "string" && colors.trim() !== "") {
      colorMap.set(prod.id, colors.trim());
    }
  }

  console.log(
    `🎨 Built color map for ${colorMap.size} MTG products with mtg_card_colors.`
  );

  // 2) Find Mongo inventory docs that are MTG and missing mtgColors
  console.log("📦 Fetching MTG items missing mtgColors from Mongo…");
  const itemsToUpdate = await InventoryItem.find({
    game: "1", // MTG game_id is 1, and we stored game as String(game_id)
    $or: [{ mtgColors: { $exists: false } }, { mtgColors: null }, { mtgColors: "" }],
  }).lean();

  console.log(
    `Found ${itemsToUpdate.length} MTG items in Mongo missing mtgColors.`
  );

  let updatedCount = 0;
  let missingInExport = 0;

  for (const item of itemsToUpdate) {
    const ctId = item.cardTraderId;
    if (!ctId) {
      continue;
    }

    const newColors = colorMap.get(ctId);
    if (!newColors) {
      missingInExport++;
      continue;
    }

    const res = await InventoryItem.findByIdAndUpdate(
      item._id,
      { $set: { mtgColors: newColors } },
      { new: true }
    );

    if (res) {
      updatedCount++;
    }
  }

  console.log(
    `🎉 Done. Updated ${updatedCount} Mongo inventory docs with mtgColors.`
  );
  console.log(
    `ℹ️ Items that had no matching mtg_card_colors in export: ${missingInExport}`
  );

  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected.");
}

main().catch((err) => {
  console.error("❌ Script failed:", err?.response?.data || err.message);
  mongoose.disconnect().finally(() => process.exit(1));
});
