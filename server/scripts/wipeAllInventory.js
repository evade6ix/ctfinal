// server/scripts/wipeAllInventory.js  (ESM VERSION)
// Run from repo root with:
//   node server/scripts/wipeAllInventory.js

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

// -----------------------------
// ENV LOADING (root .env)
// -----------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of repo is two levels up: /workspaces/ctfinal
const rootEnvPath = path.resolve(__dirname, "../../.env");

// Load .env from repo root
dotenv.config({ path: rootEnvPath });

// Helper: pick first existing env var from list
function pickEnv(names) {
  for (const name of names) {
    if (process.env[name]) {
      console.log(`🔑 Using ${name} from .env`);
      return process.env[name];
    }
  }
  return null;
}

// Try a bunch of possible names so it "just works"
const CT_API_TOKEN = pickEnv([
  "CARDTRADER_API_TOKEN",
  "CT_API_TOKEN",
  "CARDTRADER_TOKEN",
  "CARDTRADER_BEARER",
  "CT_BEARER",
  "CT_API_KEY",
]);

const MONGO_URI = pickEnv([
  "MONGODB_URI",
  "MONGO_URI",
  "MONGO_URL",
  "DATABASE_URL",
]);

if (!CT_API_TOKEN) {
  console.error(
    "❌ Could not find a CardTrader token in env. Tried: CARDTRADER_API_TOKEN, CT_API_TOKEN, CARDTRADER_TOKEN, CARDTRADER_BEARER, CT_BEARER, CT_API_KEY"
  );
  process.exit(1);
}

if (!MONGO_URI) {
  console.error(
    "❌ Could not find a Mongo URI in env. Tried: MONGODB_URI, MONGO_URI, MONGO_URL, DATABASE_URL"
  );
  process.exit(1);
}

// -----------------------------
// Helpers
// -----------------------------
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// -----------------------------
// STEP 1 — WIPE CARDTRADER INVENTORY
// -----------------------------
async function wipeCardTraderInventory() {
  console.log("🌐 Fetching current CardTrader products from /products/export ...");

  const exportRes = await axios.get(
    "https://api.cardtrader.com/api/v2/products/export",
    {
      headers: {
        Authorization: `Bearer ${CT_API_TOKEN}`,
      },
      timeout: 180000,
    }
  );

  const products = exportRes.data || [];

  if (!Array.isArray(products) || products.length === 0) {
    console.log("✅ No CardTrader products found.");
    return;
  }

  console.log(`📦 Found ${products.length} products on CardTrader.`);

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
      const res = await axios.post(
        "https://api.cardtrader.com/api/v2/products/bulk_destroy",
        payload,
        {
          headers: {
            Authorization: `Bearer ${CT_API_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`   ➜ Job ID: ${res.data?.job || "unknown"}`);
    } catch (err) {
      console.error(
        `❌ Error on batch ${batchIndex}:`,
        err.response?.data || err.message
      );
    }
  }

  console.log("✅ Finished sending bulk_destroy jobs.");
}

// -----------------------------
// STEP 2 — CLEAR LOCAL BINS
// -----------------------------
async function wipeLocalBins() {
  console.log("🗄️ Connecting to MongoDB...");

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const result = await InventoryItem.updateMany(
    {},
    {
      $set: {
        locations: [],
        quantity: 0,
        totalQuantity: 0,
      },
    }
  );

  console.log(
    `🧹 Cleared bins on ${
      result.modifiedCount || result.nModified || 0
    } inventory items.`
  );

  await mongoose.disconnect();
  console.log("🔌 Disconnected from MongoDB");
}

// -----------------------------
// MAIN EXECUTION
// -----------------------------
(async () => {
  console.log(
    "⚠️ WARNING: This will DELETE **ALL** CardTrader inventory + clear ALL bins."
  );
  console.log("Press CTRL+C now if this was accidental.\n");

  try {
    await wipeCardTraderInventory();
    await wipeLocalBins();
    console.log("\n🎯 Done — CardTrader inventory wiped + all bins cleared.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  }
})();