// server/scripts/wipeAllInventory.js
// Run with:  node server/scripts/wipeAllInventory.js
// ⚠️ This will:
//   1) DELETE ALL CardTrader products (listings)
//   2) DELETE ALL InventoryItem docs in Mongo
//   3) DELETE ALL Bin docs in Mongo

import "dotenv/config";
import axios from "axios";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { Bin } from "../models/Bin.js";

// ==============================
// ENV VARS
// ==============================
const CT_API_TOKEN =
  process.env.CARDTRADER_TOKEN ||
  process.env.CARDTRADER_API_TOKEN ||
  process.env.CT_API_TOKEN;

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

if (!CT_API_TOKEN) {
  console.error(
    "❌ Missing CardTrader token. Set CARDTRADER_TOKEN (or CARDTRADER_API_TOKEN / CT_API_TOKEN) in .env"
  );
  process.exit(1);
}

if (!MONGO_URI) {
  console.error(
    "❌ Missing Mongo URI. Set MONGO_URI (or MONGODB_URI / MONGO_URL) in .env"
  );
  process.exit(1);
}

const CT_BASE = "https://api.cardtrader.com/api/v2";

const ct = axios.create({
  baseURL: CT_BASE,
  headers: { Authorization: `Bearer ${CT_API_TOKEN}` },
  timeout: 180000,
});

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ==============================
// STEP 1 — WIPE CARDTRADER INVENTORY
// ==============================
async function wipeCardTraderInventory() {
  console.log("🌐 Fetching current CardTrader products from /products/export ...");

  const exportRes = await ct.get("/products/export");
  const products = exportRes.data || [];

  if (!Array.isArray(products) || products.length === 0) {
    console.log("✅ No CardTrader products found. Nothing to delete.");
    return;
  }

  console.log(`📦 Found ${products.length} products in CardTrader inventory.`);

  const chunks = chunkArray(products, 500);
  let batchIndex = 0;

  for (const chunk of chunks) {
    batchIndex++;

    const payload = {
      products: chunk.map((p) => ({ id: p.id })),
    };

    console.log(
      `🧨 Deleting batch ${batchIndex}/${chunks.length} (${chunk.length} products)...`
    );

    try {
      const res = await ct.post("/products/bulk_destroy", payload, {
        headers: { "Content-Type": "application/json" },
      });

      console.log(
        `   ➜ bulk_destroy job id: ${res.data?.job || "unknown"}`
      );
    } catch (err) {
      console.error(
        `❌ Error on CardTrader batch ${batchIndex}:`,
        err.response?.data || err.message
      );
    }
  }

  console.log("✅ Finished sending bulk_destroy jobs to CardTrader.");
}

// ==============================
// STEP 2 — WIPE MONGO INVENTORY + BINS
// ==============================
async function wipeMongoInventoryAndBins() {
  console.log("🗄️ Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  console.log("🧹 Deleting ALL InventoryItem documents...");
  const invResult = await InventoryItem.deleteMany({});
  console.log(
    `   ➜ Deleted ${invResult.deletedCount ?? 0} InventoryItem docs`
  );

  console.log("🧹 Deleting ALL Bin documents...");
  const binResult = await Bin.deleteMany({});
  console.log(`   ➜ Deleted ${binResult.deletedCount ?? 0} Bin docs`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected from MongoDB");
}

// ==============================
// MAIN EXECUTION
// ==============================
(async () => {
  console.log("⚠️ WARNING ⚠️");
  console.log(
    "This script will DELETE **ALL** CardTrader inventory, ALL InventoryItem docs, and ALL Bin docs."
  );
  console.log("If this was accidental, hit CTRL+C NOW.\n");

  try {
    await wipeCardTraderInventory();
    await wipeMongoInventoryAndBins();
    console.log("\n🎯 Done — CardTrader inventory, InventoryItem, and Bin collections wiped.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error in wipeAllInventory:", err);
    process.exit(1);
  }
})();

