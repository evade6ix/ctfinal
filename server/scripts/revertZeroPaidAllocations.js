// server/scripts/revertZeroPaidAllocations.js
import "dotenv/config";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const MONGO_URI = process.env.MONGO_URI;

// 👇 Use CardTrader *order codes* here (like "202601214vxsr6")
const TARGET_ORDER_CODES = [
  "202601214vxsr6", // your weekly Ct connect order
  // add more codes here if needed
];

async function revertOneByCode(orderCode) {
  console.log("\n=====================================");
  console.log(`🔁 Reverting allocations for orderCode=${orderCode}`);
  console.log("=====================================");

  const allocations = await OrderAllocation.find({ orderCode }).lean();

  if (!allocations.length) {
    console.log(
      `⚠️  No OrderAllocation docs found with orderCode=${orderCode}`
    );
    return;
  }

  console.log(`   Found ${allocations.length} allocation docs for this orderCode.`);

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

    const item = await InventoryItem.findOne({ cardTraderId });

    if (!item) {
      console.warn(
        `   ⚠️ InventoryItem not found for cardTraderId=${cardTraderId}, skipping.`
      );
      continue;
    }

    let restoredForThisItem = 0;

    for (const loc of picked) {
      if (!loc.bin || !loc.row || !loc.quantity) continue;

      const binIdStr = String(loc.bin);
      const rowNum = Number(loc.row);
      const qty = Number(loc.quantity) || 0;

      restoredForThisItem += qty;

      // Find matching location by bin+row
      const existingLoc = item.locations.find(
        (l) => String(l.bin) === binIdStr && Number(l.row) === rowNum
      );

      if (existingLoc) {
        existingLoc.quantity = (existingLoc.quantity || 0) + qty;
      } else {
        // If the bin/row combo somehow isn't present, recreate it
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

    // Restore totalQuantity for this item
    item.totalQuantity = (item.totalQuantity || 0) + restoredForThisItem;
    await item.save();

    itemsTouched += 1;
    totalCardsRestored += restoredForThisItem;
  }

  // Remove all allocations for this code so the system no longer
  // thinks this order has already consumed stock
  const deleteResult = await OrderAllocation.deleteMany({ orderCode });

  console.log(`\n✅ Finished reverting orderCode=${orderCode}`);
  console.log(`   Inventory items touched: ${itemsTouched}`);
  console.log(`   Total cards restored:    ${totalCardsRestored}`);
  console.log(`   OrderAllocation docs removed: ${deleteResult.deletedCount}`);
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI in .env");
    process.exit(1);
  }

  if (!TARGET_ORDER_CODES.length) {
    console.error("❌ Please set TARGET_ORDER_CODES in revertZeroPaidAllocations.js before running.");
    process.exit(1);
  }

  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected.");

  for (const code of TARGET_ORDER_CODES) {
    try {
      await revertOneByCode(code);
    } catch (err) {
      console.error(`❌ Error while reverting orderCode=${code}:`, err);
    }
  }

  await mongoose.disconnect();
  console.log("\n🔌 Disconnected. Done.");
}

main().catch((err) => {
  console.error("❌ Script error:", err);
  process.exit(1);
});
