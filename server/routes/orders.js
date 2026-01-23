// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";

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

    console.log("Fetched", allOrders.length, "orders");

    const mapped = allOrders.map((o) => {
      // Extract date from code (YYYYMMDDxxxx)
      let extractedDate = null;
      if (o.code && o.code.length >= 8) {
        const d = o.code.substring(0, 8);
        extractedDate = `${d.substring(0, 4)}-${d.substring(
          4,
          6
        )}-${d.substring(6, 8)}`;
      }

      return {
        id: o.id, // numeric id used everywhere
        code: o.code,
        state: o.state,
        orderAs: o.order_as,
        buyer: o.buyer || null,
        size: o.size,
        date: extractedDate,
        sellerTotalCents: o.seller_total?.cents ?? null,
        sellerTotalCurrency: o.seller_total?.currency ?? null,
        formattedTotal: o.formatted_total ?? null,
        // allocated flag filled below
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
// Helpers for sync
// =======================================================

async function fetchAllocatedOrdersFromCardTrader() {
  const client = ct();

  let page = 1;
  const limit = 50;
  const eligibleOrders = [];

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

    // Treat PAID / SENT as "allocated"/safe to deduct
    const filtered = batch.filter(
      (o) => o.state === "paid" || o.state === "sent"
    );
    eligibleOrders.push(...filtered);

    if (batch.length < limit) break;
    page++;
  }

  return eligibleOrders;
}

function extractLineData(line) {
  const cardTraderId =
    line.card_trader_id ||
    line.product_id ||
    line.blueprint_id ||
    line.cardTraderId;

  const quantity = line.quantity || line.qty || 0;

  return { cardTraderId, quantity };
}

// POST /api/orders/sync
// For each paid/sent order: if not allocated yet, trigger allocation by calling /api/order-articles/:id once.
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

    // ✅ DEBUG BLOCK (PUT IT HERE)
    const states = {};
    for (const o of allOrders) {
      const s = o.state ?? o.status ?? "UNKNOWN";
      states[s] = (states[s] || 0) + 1;
    }
    console.log("DEBUG /api/orders/sync states:", states);
    console.log("DEBUG /api/orders/sync sample order:", allOrders[0]);

    const eligible = allOrders.filter((o) => {
  const s = String(o.state || "").toLowerCase();
  const isZero = !!o.via_cardtrader_zero;
  if (!isZero) return false;

  // CardTrader Zero "real order" states (yours is hub_pending)
  return s === "hub_pending" || s === "sent" || s === "paid";
});


    let triggered = 0;
    let skippedAlreadyAllocated = 0;

    for (const o of eligible) {
      const orderIdStr = String(o.id);

      // If we've already allocated ANY line for this order, skip triggering again.
      // (Your order-articles route is also safe if called again, but this reduces work.)
      const hasAnyAlloc = await OrderAllocation.exists({ orderId: orderIdStr });
      if (hasAnyAlloc) {
        skippedAlreadyAllocated++;
        continue;
      }

      // 🔥 Trigger the same logic your UI triggers.
      // This will deduct bins + write OrderAllocation docs.
      const url = `http://localhost:${process.env.PORT || 3000}/api/order-articles/${o.id}`;
      const resp = await fetch(url);

      if (!resp.ok) {
        const raw = await resp.text().catch(() => "");
        console.error("❌ Failed to allocate order via order-articles", o.id, resp.status, raw);
        continue;
      }

      triggered++;
    }

    res.json({
      ok: true,
      eligibleOrders: eligible.length,
      triggered,
      skippedAlreadyAllocated,
    });
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
