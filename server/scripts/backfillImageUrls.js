import "dotenv/config";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to Mongo");

  const items = await InventoryItem.find({
    $or: [{ imageUrl: { $exists: false } }, { imageUrl: null }]
  });

  console.log(`Found ${items.length} items missing imageUrl`);

  for (const item of items) {
    const blueprintId = item.blueprintId ?? item.cardTraderId;

    if (!blueprintId) {
      console.log(`Skipping item ${item._id} → no blueprintId`);
      continue;
    }

    const url = `https://img.cardtrader.com/blueprints/${blueprintId}/front.jpg`;

    item.imageUrl = url;

    await item.save();
    console.log(`Updated ${item.name} (${item._id})`);
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill error:", err);
  process.exit(1);
});
