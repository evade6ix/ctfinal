// server/scripts/recalcTotalsFromBins.js
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import { InventoryItem } from "../models/InventoryItem.js";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔧 Load ROOT .env (D:\ctfinal\.env) even though this file is in /server/scripts
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in root .env");
  process.exit(1);
}

async function main() {
  console.log("🔌 Connecting to Mongo...");
  await mongoose.connect(MONGO_URI);

  console.log("🔎 Fetching all inventory items...");
  const items = await InventoryItem.find({});
  console.log(`📦 Found ${items.length} inventory items.`);

  let scanned = 0;
  let updated = 0;
  let skippedNoLocations = 0;
  let skippedAlreadyCorrect = 0;

  for (const item of items) {
    scanned += 1;

    const locations = Array.isArray(item.locations) ? item.locations : [];

    if (locations.length === 0) {
      // nothing binned for this item; leave totalQuantity alone
      skippedNoLocations += 1;
      continue;
    }

    const assigned = locations.reduce(
      (sum, loc) => sum + (Number(loc.quantity) || 0),
      0
    );

    if (Number(item.totalQuantity) === assigned) {
      skippedAlreadyCorrect += 1;
      continue;
    }

    console.log(
      `🛠 Fixing "${item.name || "Unknown"}" (${item.setCode || "?"}) ` +
        `totalQuantity ${item.totalQuantity} → ${assigned}`
    );

    item.totalQuantity = assigned;
    await item.save();
    updated += 1;
  }

  console.log("✅ Recalc complete.");
  console.log(`   Scanned:              ${scanned}`);
  console.log(`   Updated:              ${updated}`);
  console.log(`   Skipped (no bins):    ${skippedNoLocations}`);
  console.log(`   Skipped (already ok): ${skippedAlreadyCorrect}`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected. Done.");
}

main().catch((err) => {
  console.error("❌ Script error:", err);
  process.exit(1);
});
