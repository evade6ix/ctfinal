import "dotenv/config";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo");

  const items = await InventoryItem.find(
    { setCode: { $ne: null } },
    { setCode: 1 }
  ).lean();

  console.log(`Found ${items.length} items with a setCode to normalize.`);

  let updated = 0;

  for (const item of items) {
    const current = item.setCode;
    if (typeof current !== "string") continue;

    const lower = current.toLowerCase().trim(); // normalize + trim

    if (current !== lower) {
      await InventoryItem.updateOne(
        { _id: item._id },
        { $set: { setCode: lower } }
      );
      updated++;
    }
  }

  console.log(`✅ Normalized setCode to lowercase on ${updated} items.`);
  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected.");
}

main().catch((err) => {
  console.error("❌ Normalize failed:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
