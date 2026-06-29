// server/routes/orders-weekly.js
import express from "express";

const router = express.Router();

/**
 * GET /api/orders-weekly
 *
 * CardTrader Zero Weekly Grouped view.
 *
 * IMPORTANT:
 * - This is DISPLAY ONLY.
 * - It should show the consolidated CardTrader Zero shipment orders.
 * - It should NOT show the active hub_pending orders from Daily Sales.
 * - Inventory deduction happens earlier from hub_pending orders only.
 */
router.get("/", async (req, res) => {
  try {
    const port = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${port}/api/orders`;

    const r = await fetch(url);

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error(
        `❌ /api/orders-weekly: failed to fetch /api/orders (${r.status})`,
        txt.slice(0, 300)
      );

      return res
        .status(500)
        .json({ error: "Failed to fetch orders for weekly summary" });
    }

    const orders = await r.json();

    if (!Array.isArray(orders)) {
      console.warn("⚠️ /api/orders-weekly: /api/orders did not return an array");
      return res.json([]);
    }

    const shipmentStates = new Set(["paid", "sent", "done"]);

    const shipmentOrders = orders.filter((o) => {
      const state = String(o.state || "").toLowerCase();
      return o.viaCardTraderZero === true && shipmentStates.has(state);
    });

    const groups = {};

    for (const o of shipmentOrders) {
      const paidAt = o.paid_at || o.paidAt || o.createdAt || null;
      const rawDate =
        paidAt ||
        (o.code && String(o.code).length >= 8
          ? `${String(o.code).slice(0, 4)}-${String(o.code).slice(
              4,
              6
            )}-${String(o.code).slice(6, 8)}T00:00:00.000Z`
          : null);

      const d = rawDate ? new Date(rawDate) : null;
      const groupDate =
        d && !Number.isNaN(d.getTime())
          ? d.toISOString().substring(0, 10)
          : "unknown";

      if (!groups[groupDate]) {
        groups[groupDate] = {
          weekStart: groupDate,
          shipmentDate: groupDate,
          totalOrders: 0,
          totalValueCents: 0,
          orders: [],
        };
      }

      groups[groupDate].totalOrders += 1;
      groups[groupDate].totalValueCents += Number(o.sellerTotalCents || 0);
      groups[groupDate].orders.push(o);
    }

    const output = Object.values(groups).sort(
      (a, b) => new Date(b.shipmentDate) - new Date(a.shipmentDate)
    );

    output.forEach((group) => {
      group.totalValue = (group.totalValueCents / 100).toFixed(2);
    });

    console.log(
      `[/api/orders-weekly] computed ${output.length} CT Zero shipment groups from ${shipmentOrders.length} consolidated shipment orders (raw orders: ${orders.length})`
    );

    return res.json(output);
  } catch (err) {
    console.error("❌ weekly error:", err);

    return res.status(500).json({
      error: "Failed to compute weekly shipments",
      details: err.message,
    });
  }
});

export default router;