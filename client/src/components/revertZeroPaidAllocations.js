// server/scripts/revertZeroPaidAllocations.js
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔧 Load ROOT .env (like D:\ctfinal\.env)
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const MONGO_URI = process.env.MONGO_URI;

// ⬇️ FILL THIS IN ⬇️
// These are the *CardTrader numeric order IDs* (NOT the code) that were
// wrongly allocated when they were in PAID state (your weekly Zero shipments).
// Example: ["28933613"]
const TARGET_ORDER_IDS = [
  // "202601214vxsr6", // <- put your weekly order id here
];

async function revertOneOrder(orderIdStr) {
  console.log(`\n==============================`);
  console.log(`🔁 Reverting allocations for orderId=${orderIdStr}`);
  console.log(`==============================`);

  const allocations = await OrderAllocation.find({
    orderId: String(orderIdStr),
  }).lean();

  if (!allocations.length) {
    console.log(`⚠️  No OrderAllocation docs found for orderId=${orderIdStr}`);
    return;
  }

  console.log(`   Found ${allocations.length} allocation docs for this order.`);

  let totalCardsRestored = 0;
  let itemsTouched = 0;

  for (const alloc of allocations) {
    const cardTraderId = alloc.cardTraderId;
    const picked = Array.isArray(alloc.pickedLocations)
      ? alloc.pickedLocations
      : [];

    if (!cardTraderId || picked.length === 0) {
      console.log(
        `   🔸 Skipping allocation _id=${alloc._id} (missing cardTraderId or pickedLocations)`
      );
      continue;
    }

    const qtyForThisItem = picked.reduce(
      (sum, loc) => sum + (loc.quantity || 0),
      0
    );

    console.log(
      `   ▶ Restoring cardTraderId=${cardTraderId} (total picked=${qtyForThisItem})`
    );

    const item = await InventoryItem.findOne({ cardTraderId: cardTraderId });

    if (!item) {
      console.warn(
        `      ⚠️ InventoryItem not found for cardTraderId=${cardTraderId}, skipping.`
      );
      continue;
    }

    // Restore bins/rows
    for (const loc of picked) {
      if (!loc.bin || !loc.row || !loc.quantity) continue;

      const binIdStr = String(loc.bin);
      const rowNum = loc.row;
      const qty = loc.quantity;

      // Find matching location by bin+row
      const existingLoc = item.locations.find(
        (l) =>
          String(l.bin) === binIdStr &&
          Number(l.row) === Number(rowNum)
      );

      if (existingLoc) {
        existingLoc.quantity = (existingLoc.quantity || 0) + qty;
      } else {
        // If for some reason the bin/row combo isn't there, recreate it
        item.locations.push({
          bin: loc.bin,
          row: rowNum,
          quantity: qty,
        });
      }

      console.log(
        `      ➕ Bin ${binIdStr} row ${rowNum}: +${qty} (restored)`
      );
    }

    // Restore totalQuantity
    item.totalQuantity = (item.totalQuantity || 0) + qtyForThisItem;

    await item.save();
    itemsTouched += 1;
    totalCardsRestored += qtyForThisItem;
  }

  // 🔥 Remove the allocations so the system no longer thinks this order
  // has already consumed stock
  const deleteResult = await OrderAllocation.deleteMany({
    orderId: String(orderIdStr),
  });

  console.log(`\n✅ Finished reverting orderId=${orderIdStr}`);
  console.log(`   Inventory items touched: ${itemsTouched}`);
  console.log(`   Total cards restored:    ${totalCardsRestored}`);
  console.log(`   OrderAllocation docs removed: ${deleteResult.deletedCount}`);
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI in .env");
    process.exit(1);
  }

  if (!TARGET_ORDER_IDS.length) {
    console.error(
      "❌ Please set TARGET_ORDER_IDS in revertZeroPaidAllocations.js before running."
    );
    process.exit(1);
  }

  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected.");

  for (const id of TARGET_ORDER_IDS) {
    try {
      await revertOneOrder(id);
    } catch (err) {
      console.error(`❌ Error while reverting order ${id}:`, err);
    }
  }

  await mongoose.disconnect();
  console.log("\n🔌 Disconnected. Done.");
}

main().catch((err) => {
  console.error("❌ Script error:", err);
  process.exit(1);
});
