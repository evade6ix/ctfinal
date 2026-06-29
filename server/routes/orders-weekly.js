// server/routes/orders-weekly.js
import express from "express";

const router = express.Router();

/**
 * GET /api/orders-weekly
 *
 * CardTrader Zero Weekly Shipments
 *
 * CORRECT BEHAVIOR:
 * - Show NOTHING before CardTrader creates the weekly consolidated shipment.
 * - Show ONLY live consolidated CT Zero shipment orders.
 * - That means:
 *   viaCardTraderZero === true
 *   state === "paid"
 *
 * DO NOT show:
 * - hub_pending orders
 * - sent orders
 * - done orders
 * - old historical shipments
 *
 * This route is DISPLAY ONLY.
 * It must never allocate or deduct inventory.
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
        .json({ error: "Failed to fetch CardTrader weekly shipments" });
    }

    const orders = await r.json();

    if (!Array.isArray(orders)) {
      console.warn("⚠️ /api/orders-weekly: /api/orders did not return array");
      return res.json([]);
    }

    const liveShipmentOrders = orders.filter((o) => {
      const state = String(o.state || "").toLowerCase();

      return o.viaCardTraderZero === true && state === "paid";
    });

    const output = liveShipmentOrders.map((o) => {
      const paidAt = o.paid_at || o.paidAt || null;

      return {
        shipmentId: String(o.id),
        weekStart: paidAt
          ? new Date(paidAt).toISOString().substring(0, 10)
          : "live",
        shipmentDate: paidAt
          ? new Date(paidAt).toISOString().substring(0, 10)
          : "live",
        totalOrders: 1,
        totalValueCents: Number(o.sellerTotalCents || 0),
        totalValue: (Number(o.sellerTotalCents || 0) / 100).toFixed(2),
        orders: [o],
      };
    });

    console.log(
      `[/api/orders-weekly] live CT Zero paid shipments: ${output.length} from raw orders: ${orders.length}`
    );

    return res.json(output);
  } catch (err) {
    console.error("❌ /api/orders-weekly error:", err);

    return res.status(500).json({
      error: "Failed to compute CardTrader weekly shipments",
      details: err.message,
    });
  }
});

export default router;