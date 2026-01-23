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
  const allocatedOrders = [];

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

    // Only keep allocated orders
    const filtered = batch.filter((o) => o.state === "allocated");
    allocatedOrders.push(...filtered);

    if (batch.length < limit) break;
    page++;
  }

  return allocatedOrders;
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

// =======================================================
// POST /api/orders/sync
//  - Decrements bins ONCE per order line (idempotent)
// =======================================================
router.post("/sync", async (req, res) => {
  try {
    const orders = await fetchAllocatedOrdersFromCardTrader();
    let updatedLines = 0;

    for (const order of orders) {
      const orderId = String(order.id);
      const lines = order.lines || order.items || [];

      for (const line of lines) {
        const { cardTraderId, quantity } = extractLineData(line);
        if (!cardTraderId || !quantity) continue;

        const lineKey = `${orderId}:${cardTraderId}`;

        // 1️⃣ Skip if already processed
        const already = await OrderAllocation.findOne({ lineKey });
        if (already) continue;

        // 2️⃣ Find matching inventory item
        const item = await InventoryItem.findOne({ cardTraderId });
        if (!item) {
          // Still store the allocation so we don't retry forever
          await OrderAllocation.create({ orderId, lineKey });
          continue;
        }

        if (!item.locations || item.locations.length === 0) {
          await OrderAllocation.create({ orderId, lineKey });
          continue;
        }

        // 3️⃣ Decrement bins
        let remaining = quantity;

        for (const loc of item.locations) {
          if (remaining <= 0) break;
          const take = Math.min(loc.quantity, remaining);
          loc.quantity -= take;
          remaining -= take;
        }

        await item.save();

        // 4️⃣ Mark processed so we never subtract twice
        await OrderAllocation.create({ orderId, lineKey });

        updatedLines++;
      }
    }

    res.json({
      ok: true,
      updatedLines,
      message: `Applied ${updatedLines} order lines`,
    });
  } catch (err) {
    console.error("❌ Order sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
