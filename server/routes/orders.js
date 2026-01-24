// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

// =======================================================
// GET /api/orders
//  - Lists orders with allocated flag (no in-memory cache)
// =======================================================
router.get("/", async (req, res) => {
  try {
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

    console.log("Fetched", allOrders.length, "orders");
    if (allOrders.length > 0) {
      console.log("DEBUG /api/orders sample order:", allOrders[0]);
    }

    const mapped = allOrders.map((o) => {
  // ✅ Prefer the created_at of the first order item
  let rawCreated = null;

  if (Array.isArray(o.order_items) && o.order_items.length > 0) {
    rawCreated = o.order_items[0].created_at || null;
  }

  // 🔁 Fallback: derive a date from the order code (YYYYMMDDxxxx)
  if (!rawCreated && o.code && o.code.length >= 8) {
    const d = o.code.substring(0, 8); // e.g. "20260124"
    const year = d.substring(0, 4);
    const month = d.substring(4, 6);
    const day = d.substring(6, 8);
    // Build a UTC midnight timestamp so frontend can still format it
    rawCreated = `${year}-${month}-${day}T00:00:00.000Z`;
  }

  return {
    id: o.id, // numeric id used everywhere
    code: o.code,
    state: o.state,
    orderAs: o.order_as,
    buyer: o.buyer || null,
    size: o.size,

    // ✅ Final createdAt value (UTC-ish ISO string)
    createdAt: rawCreated,

    sellerTotalCents: o.seller_total?.cents ?? null,
    sellerTotalCurrency: o.seller_total?.currency ?? null,
    formattedTotal: o.formatted_total ?? null,
    // allocated filled below
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

    res.json(mappedWithFlag);
  } catch (err) {
    console.error("❌ Error fetching orders:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// =======================================================
// POST /api/orders/sync
//  - For each Zero order in hub_pending/paid/sent that
//    has no allocations yet, call /api/order-articles/:id
//    so bins are deducted & OrderAllocation rows are written.
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

    // Debug: state counts
    const stateCounts = {};
    for (const o of allOrders) {
      const s = o.state ?? o.status ?? "UNKNOWN";
      stateCounts[s] = (stateCounts[s] || 0) + 1;
    }
    console.log("DEBUG /api/orders/sync states:", stateCounts);
    console.log("DEBUG /api/orders/sync sample order:", allOrders[0]);

    // Only CardTrader Zero orders that are real (hub_pending/paid/sent)
    const eligible = allOrders.filter((o) => {
      const s = String(o.state || "").toLowerCase();
      const isZero = !!o.via_cardtrader_zero;
      if (!isZero) return false;
      return s === "hub_pending" || s === "sent" || s === "paid";
    });

    let triggered = 0;
    let skippedAlreadyAllocated = 0;
    let failed = 0;

    for (const o of eligible) {
      const orderIdStr = String(o.id);

      // Skip if *any* allocation exists for this order
      const hasAnyAlloc = await OrderAllocation.exists({ orderId: orderIdStr });
      if (hasAnyAlloc) {
        skippedAlreadyAllocated++;
        continue;
      }

      const url = `http://localhost:${process.env.PORT || 3000}/api/order-articles/${o.id}`;
      console.log(`🔁 [ORDERS] Allocating order ${orderIdStr} via ${url}`);

      try {
        const resp = await fetch(url);
        const raw = await resp.text().catch(() => "");

        if (!resp.ok) {
          console.error(
            "❌ Failed to allocate order via order-articles",
            o.id,
            resp.status,
            raw.slice(0, 300)
          );
          failed++;
          continue;
        }

        triggered++;
      } catch (err) {
        console.error(
          "❌ Error allocating order via order-articles",
          o.id,
          err?.message || err
        );
        failed++;
      }
    }

    const summary = {
      ok: true,
      fetchedOrders: allOrders.length,
      eligibleOrders: eligible.length,
      processedThisRun: triggered + skippedAlreadyAllocated + failed,
      triggered,
      skippedAlreadyAllocated,
      failed,
    };

    console.log("✅ [ORDERS] sync summary", summary);
    res.json(summary);
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
