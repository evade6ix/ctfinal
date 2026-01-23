// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

// simple in-memory cache to avoid spamming CT
let cachedOrders = null;
let cachedTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

// =======================================================
// GET /api/orders
//  - Lists orders with allocated flag
// =======================================================
router.get("/", async (req, res) => {
  try {
    const now = Date.now();
    if (cachedOrders && now - cachedTime < CACHE_TTL) {
      return res.json(cachedOrders);
    }

    const client = ct();
    let page = 1;
    const limit = 50;
    const allOrders = [];

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

    const mapped = allOrders.map((o) => {
      // Extract date from code (YYYYMMDDxxxx)
      let extractedDate = null;
      if (o.code && o.code.length >= 8) {
        const d = o.code.substring(0, 8);
        extractedDate = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
      }

      return {
        id: o.id,
        code: o.code,
        state: o.state,
        orderAs: o.order_as,
        buyer: o.buyer || null,
        size: o.size,
        date: extractedDate,
        sellerTotalCents: o.seller_total?.cents ?? null,
        sellerTotalCurrency: o.seller_total?.currency ?? null,
        formattedTotal: o.formatted_total ?? null,
      };
    });

    // 🔹 Figure out which orders already have allocations
    const orderIdStrings = mapped.map((o) => String(o.id));
    const allocations = await OrderAllocation.find(
      { orderId: { $in: orderIdStrings } },
      "orderId"
    ).lean();

    const allocatedSet = new Set(allocations.map((a) => a.orderId));

    const mappedWithFlag = mapped.map((o) => ({
      ...o,
      allocated: allocatedSet.has(String(o.id)),
    }));

    cachedOrders = mappedWithFlag;
    cachedTime = Date.now();

    res.json(mappedWithFlag);
  } catch (err) {
    console.error("❌ Error fetching orders:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// =======================================================
// POST /api/orders/sync
//  - Poll CardTrader orders
//  - For CardTrader Zero (via_cardtrader_zero), treat hub_pending as "real"
//  - For each eligible order that has no allocations yet:
//      trigger allocation by calling /api/order-articles/:id once
//  - Safe to run repeatedly due to OrderAllocation idempotency
// =======================================================
router.post("/sync", async (req, res) => {
  try {
    const client = ct();

    let page = 1;
    const limit = 50;
    const allOrders = [];

    while (true) {
      const r = await client.get("/orders", {
        params: { order_as: "seller", sort: "date.desc", page, limit },
      });

      const batch = Array.isArray(r.data) ? r.data : [];
      if (!batch.length) break;

      allOrders.push(...batch);
      if (batch.length < limit) break;
      page++;
    }

    // CardTrader Zero: once you see it, treat as ready.
    const eligible = allOrders.filter((o) => {
      const s = String(o.state || "").toLowerCase();
      const isZero = !!o.via_cardtrader_zero;
      if (!isZero) return false;

      // Zero "real" states we can allocate/deduct on
      return s === "hub_pending" || s === "sent" || s === "paid";
    });

    // ✅ Safety cap so we don't slam CT (and your own server) every minute
    const MAX_PER_RUN = Number(process.env.ORDERS_SYNC_MAX || 10);
    const toProcess = eligible.slice(0, MAX_PER_RUN);

    let triggered = 0;
    let skippedAlreadyAllocated = 0;
    let failed = 0;

    for (const o of toProcess) {
      const orderIdStr = String(o.id);

      // If we've already allocated ANY line for this order, skip triggering again.
      const hasAnyAlloc = await OrderAllocation.exists({ orderId: orderIdStr });
      if (hasAnyAlloc) {
        skippedAlreadyAllocated++;
        continue;
      }

      // Trigger the same logic your UI triggers (allocates + deducts + writes OrderAllocation)
      // Note: orderArticles.js needs to support skipImages=1 (we do that next step)
      const url = `http://localhost:${process.env.PORT || 3000}/api/order-articles/${o.id}?skipImages=1`;

      const resp = await fetch(url);
      if (!resp.ok) {
        const raw = await resp.text().catch(() => "");
        console.error(
          "❌ Failed to allocate order via order-articles",
          { id: o.id, status: resp.status, raw: raw?.slice(0, 500) }
        );
        failed++;
        continue;
      }

      triggered++;
    }

    // Short, safe summary log (no personal data)
    console.log("✅ [ORDERS] sync summary", {
      fetchedOrders: allOrders.length,
      eligibleOrders: eligible.length,
      processedThisRun: toProcess.length,
      triggered,
      skippedAlreadyAllocated,
      failed,
    });

    res.json({
      ok: true,
      fetchedOrders: allOrders.length,
      eligibleOrders: eligible.length,
      processedThisRun: toProcess.length,
      triggered,
      skippedAlreadyAllocated,
      failed,
    });
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
