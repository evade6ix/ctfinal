// load .env from /server no matter where we run from
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

async function clear() {
  try {
    console.log("🔌 Connecting to Mongo…");
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to Mongo");

    const result = await InventoryItem.deleteMany({});
    console.log(`🗑️ Deleted ${result.deletedCount} inventory items.`);

    await mongoose.disconnect();
    console.log("🔌 Mongo disconnected.");
  } catch (err) {
    console.error("❌ Clear failed:", err.message);
    mongoose.disconnect();
  }
}

clear();
