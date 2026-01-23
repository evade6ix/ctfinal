// =======================================================
// POST /api/orders/sync
// - Fetch allocated orders from CardTrader
// - For each line: decrement bins ONCE ONLY
// =======================================================

import { InventoryItem } from "../models/InventoryItem.js";

// Helper to fetch allocated orders from CardTrader
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

    // We only care about allocated orders here
    const filtered = batch.filter((o) => o.state === "allocated");
    allocatedOrders.push(...filtered);

    if (batch.length < limit) break;
    page++;
  }

  return allocatedOrders;
}

// Helper to extract needed data from order lines
function extractLineData(line) {
  const cardTraderId =
    line.card_trader_id ||
    line.product_id ||
    line.blueprint_id ||
    line.cardTraderId;

  const quantity = line.quantity || line.qty || 0;

  return { cardTraderId, quantity };
}

// MAIN SYNC ROUTE
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

        // Unique key (orderId + cardTraderId)
        const lineKey = `${orderId}:${cardTraderId}`;

        // 1️⃣ Check if this line was already processed
        const already = await OrderAllocation.findOne({ lineKey });
        if (already) continue;

        // 2️⃣ Find matching Mongo inventory item
        const item = await InventoryItem.findOne({ cardTraderId });
        if (!item) {
          // Still record so we never retry this same missing item
          await OrderAllocation.create({ orderId, lineKey });
          continue;
        }

        if (!item.locations || item.locations.length === 0) {
          // Item exists but has no bins → still record it to avoid loops
          await OrderAllocation.create({ orderId, lineKey });
          continue;
        }

        // 3️⃣ Decrement bins (first → next → next…)
        let remaining = quantity;

        for (const loc of item.locations) {
          if (remaining <= 0) break;
          const take = Math.min(loc.quantity, remaining);
          loc.quantity -= take;
          remaining -= take;
        }

        await item.save();

        // 4️⃣ Mark this line as processed so it never happens twice
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
