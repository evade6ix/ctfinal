// server/scripts/syncTotalsWithCardtrader.js
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import { InventoryItem } from "../models/InventoryItem.js";
import { ct } from "../ctClient.js";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ROOT .env (D:\ctfinal\.env)
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in root .env");
  process.exit(1);
}

async function fetchCardtraderInventory() {
  const client = ct();

  const allRows = [];
  let page = 1;
  const limit = 100;

  while (true) {
    // 👉 This is the endpoint you already use for "My Inventory"
    // If you have a working CT call somewhere else in your app,
    // mirror it here. Otherwise leave as /me/inventory.
    const res = await client.get("/me/inventory", {
      params: {
        page,
        limit,
      },
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) break;

    allRows.push(...rows);

    if (rows.length < limit) break;
    page += 1;
  }

  // Normalize into our schema: { cardTraderId, quantity }
  const normalized = allRows.map((row) => ({
    cardTraderId: row.product_id,
    quantity: row.quantity ?? row.amount ?? 0,
  }));

  return normalized;
}

async function main() {
  console.log("🔌 Connecting to Mongo...");
  await mongoose.connect(MONGO_URI);

  console.log("🔎 Fetching CardTrader inventory...");
  let ctRows;
  try {
    ctRows = await fetchCardtraderInventory();
  } catch (err) {
    console.error(
      "❌ Failed to fetch CardTrader inventory:",
      err?.response?.data || err.message || err
    );
    process.exit(1);
  }

  console.log(`📦 CardTrader rows: ${ctRows.length}`);

  // Build lookup: cardTraderId -> CT quantity
  const ctMap = new Map();
  for (const row of ctRows) {
    const idNum = Number(row.cardTraderId);
    if (!Number.isFinite(idNum)) continue;

    const qtyNum = Number(row.quantity) || 0;
    ctMap.set(idNum, qtyNum);
  }

  console.log("🔎 Fetching Mongo inventory items...");
  const mongoItems = await InventoryItem.find({
    cardTraderId: { $ne: null },
  });

  console.log(`📂 Mongo items with cardTraderId: ${mongoItems.length}`);

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let missingInCT = 0;

  for (const item of mongoItems) {
    scanned++;

    const ctId = Number(item.cardTraderId);
    const currentTotal = Number(item.totalQuantity) || 0;

    let ctQty = 0;
    if (ctMap.has(ctId)) {
      ctQty = ctMap.get(ctId);
    } else {
      // Item is not listed on CardTrader anymore
      missingInCT++;
    }

    if (currentTotal === ctQty) {
      unchanged++;
      continue;
    }

    console.log(
      `🛠 "${item.name || "Unknown"}" (CT ID ${ctId}) totalQuantity ${currentTotal} → ${ctQty}`
    );

    // Update ONLY totalQuantity — NO bin changes
    item.totalQuantity = ctQty;
    await item.save();
    updated++;
  }

  console.log("✅ Sync complete.");
  console.log(`   Scanned Mongo items:  ${scanned}`);
  console.log(`   Updated totals:       ${updated}`);
  console.log(`   Unchanged totals:     ${unchanged}`);
  console.log(`   Missing in CT:        ${missingInCT}`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected. Done.");
}

main().catch((err) => {
  console.error("❌ Script error:", err);
  process.exit(1);
});
