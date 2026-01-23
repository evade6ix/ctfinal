// server/scripts/fixUnallocated.js
import "dotenv/config";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";

async function run() {
  const MONGO_URI = process.env.MONGO_URI;
  const PORT = process.env.PORT || 3000;

  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  // 1️⃣ Find allocations that fulfilled NOTHING
  const unfilled = await OrderAllocation.find({
    fulfilledQuantity: 0,
  }).lean();

  console.log(`🔍 Found ${unfilled.length} unfilled allocation lines`);

  // Unique order list
  const ordersToFix = [...new Set(unfilled.map((a) => a.orderId))];
  console.log(`📝 Orders needing fix: ${ordersToFix.length}`);

  for (const orderId of ordersToFix) {
    console.log(`\n==============================`);
    console.log(`♻️ Fixing order ${orderId}`);

    // 2️⃣ Delete old unfilled lines
    const del = await OrderAllocation.deleteMany({
      orderId,
      fulfilledQuantity: 0,
    });

    console.log(`🗑️ Deleted ${del.deletedCount} unfilled allocations`);

    // 3️⃣ Re-run allocation
    const url = `http://localhost:${PORT}/api/order-articles/${orderId}`;
    console.log(`🔁 Reallocating via ${url}`);

    const res = await fetch(url);
    const raw = await res.text();

    if (!res.ok) {
      console.error("❌ Reallocation failed\n", raw);
      continue;
    }

    console.log("✅ Reallocated:", raw);
  }

  console.log("\n🎉 Done! All unfilled orders reprocessed.");
  process.exit(0);
}

run();
