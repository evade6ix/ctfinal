// server/scripts/syncQuantitiesFromCardtrader.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";

// Resolve ROOT .env (D:\ctfinal\.env)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const MONGO_URI = process.env.MONGO_URI;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in ROOT .env");
  process.exit(1);
}

if (!CARDTRADER_TOKEN) {
  console.error("❌ CARDTRADER_TOKEN missing in ROOT .env");
  process.exit(1);
}

// Local CardTrader client JUST for this script
const CT_BASE = "https://api.cardtrader.com/api/v2";

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: {
      Authorization: `Bearer ${CARDTRADER_TOKEN}`,
    },
    timeout: 20000,
  });
}

async function connectMongo() {
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo");
}

async function syncQuantitiesFromCardtrader() {
  await connectMongo();

  let page = 1;
  const perPage = 100;
  let totalUpdated = 0;
  let totalSeenOnCardtrader = 0;
  const seenIds = new Set();

  console.log("📥 Syncing quantities from CardTrader…");

  while (true) {
    console.log(`➡️ Fetching CardTrader products page ${page}…`);

    const res = await ct().get("/products", {
      params: { page, per_page: perPage },
    });

    const products = res.data?.data ?? res.data;

    if (!products || products.length === 0) {
      console.log("⛔ No more products from CardTrader.");
      break;
    }

    for (const p of products) {
      const cardTraderId = p.id;

      // Adjust this mapping if CT uses different fields in your account
      const ctQuantity =
        p.quantity_available ??
        p.available ??
        p.quantity ??
        0;

      if (!cardTraderId) continue;

      seenIds.add(cardTraderId);
      totalSeenOnCardtrader++;

      const doc = await InventoryItem.findOne({ cardTraderId });

      if (!doc) {
        continue; // nothing in local DB for this listing
      }

      // 🔒 DO NOT TOUCH LOCATIONS/BINS/ROWS
      // Just fix the top-level quantity field.
      doc.totalQuantity = ctQuantity; // or doc.quantity if that's what your UI uses

      await doc.save();
      totalUpdated++;
    }

    page++;
  }

  console.log(
    `✅ Updated ${totalUpdated} local items based on ${totalSeenOnCardtrader} CardTrader listings.`
  );

  // OPTIONAL: zero out items that no longer exist on CardTrader
  if (seenIds.size > 0) {
    const allIds = await InventoryItem.distinct("cardTraderId", {
      cardTraderId: { $ne: null },
    });

    const unseenIds = allIds.filter((id) => !seenIds.has(id));

    if (unseenIds.length > 0) {
      const res = await InventoryItem.updateMany(
        { cardTraderId: { $in: unseenIds } },
        { $set: { totalQuantity: 0 } }
      );

      console.log(
        `🧹 Zeroed quantity for ${res.modifiedCount} items not found on CardTrader.`
      );
    }
  }

  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected. Done.");
}

// Run
syncQuantitiesFromCardtrader().catch((err) => {
  console.error("❌ Sync failed:", err);
  mongoose.disconnect();
});
