// server/scripts/allocateUnallocatedOrders.js
import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

async function run() {
  const MONGO_URI = process.env.MONGO_URI;

  // 👇 Point this at Railway instead of localhost
  const API_BASE =
    process.env.SYNC_BASE_URL ||
    "https://ctfinal-production.up.railway.app";

  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const client = ct();
  let page = 1;
  const limit = 50;
  const allOrders = [];

  console.log("🔎 Fetching CardTrader seller orders...");

  while (true) {
    const r = await client.get("/orders", {
      params: {
        order_as: "seller",
        sort: "date.desc",
        page,
        limit,
      },
    });

    const batch = Array.isArray(r.data) ? r.data : [];
    if (!batch.length) break;

    allOrders.push(...batch);
    if (batch.length < limit) break;

    page++;
  }

  console.log("📦 Total orders fetched:", allOrders.length);

  // Filter to CardTrader Zero orders in "real" states
  const eligible = allOrders.filter((o) => {
    const s = String(o.state || "").toLowerCase();
    const isZero = !!o.via_cardtrader_zero;
    if (!isZero) return false;

    return s === "hub_pending" || s === "sent" || s === "paid";
  });

  console.log("✅ Eligible Zero orders:", eligible.length);

  let triggered = 0;
  let skipped = 0;
  let failed = 0;

  for (const o of eligible) {
    const orderIdStr = String(o.id);

    // Skip orders that already have ANY allocation
    const hasAlloc = await OrderAllocation.exists({ orderId: orderIdStr });
    if (hasAlloc) {
      skipped++;
      continue;
    }

    const url = `${API_BASE}/api/order-articles/${o.id}`;
    console.log(`🔁 Allocating unallocated order ${orderIdStr} via ${url}`);

    try {
      const res = await fetch(url);
      const raw = await res.text();

      if (!res.ok) {
        console.error(
          "❌ Allocation failed",
          orderIdStr,
          res.status,
          raw.slice(0, 300)
        );
        failed++;
        continue;
      }

      console.log("✅ Allocated order", orderIdStr);
      triggered++;
    } catch (err) {
      console.error(
        "❌ Error allocating order",
        orderIdStr,
        err?.message || err
      );
      failed++;
    }
  }

  console.log("\n🎉 Done allocating unallocated orders.");
  console.log({
    triggered,
    skippedAlreadyAllocated: skipped,
    failed,
  });

  process.exit(0);
}

run();
