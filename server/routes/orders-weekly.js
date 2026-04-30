// server/routes/orders-weekly.js
import express from "express";

const router = express.Router();

/**
 * GET /api/orders-weekly
 * Groups CardTrader Zero HUB_PENDING seller orders by completed week.
 *
 * Important:
 * - Keeps the old grouped shipment style.
 * - Hides the current active/open week.
 * - Card/bin details still come from /api/order-articles/:id,
 *   which reads OrderAllocation.pickedLocations.
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

    const eligibleOrders = orders.filter((o) => {
      const state = String(o.state || "").toLowerCase();
      return state === "hub_pending";
    });

    // Monday-based week start, matching your current UI labels.
    const getWeekId = (createdAt) => {
      if (!createdAt) return "unknown";

      const d = new Date(createdAt);
      if (isNaN(d.getTime())) return "unknown";

      const day = d.getDay(); // Sun=0, Mon=1...
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);

      const monday = new Date(d);
      monday.setDate(diff);
      monday.setHours(0, 0, 0, 0);

      return monday.toISOString().substring(0, 10);
    };

    const currentWeekId = getWeekId(new Date().toISOString());

    const weeks = {};

    for (const o of eligibleOrders) {
      const weekId = getWeekId(o.createdAt);

      // Hide the current active/open week.
      // This prevents cards from the next still-building shipment
      // from appearing in the weekly shipping group.
      if (weekId === currentWeekId) {
        continue;
      }

      if (!weeks[weekId]) {
        weeks[weekId] = {
          weekStart: weekId,
          totalOrders: 0,
          totalValueCents: 0,
          orders: [],
        };
      }

      weeks[weekId].totalOrders += 1;
      weeks[weekId].totalValueCents += o.sellerTotalCents ?? 0;
      weeks[weekId].orders.push(o);
    }

    const output = Object.values(weeks).sort(
      (a, b) => new Date(b.weekStart) - new Date(a.weekStart)
    );

    output.forEach((w) => {
      w.totalValue = (w.totalValueCents / 100).toFixed(2);
    });

    console.log(
      `[/api/orders-weekly] computed ${output.length} completed weeks from ${eligibleOrders.length} eligible orders (raw orders: ${orders.length}, hidden current week: ${currentWeekId})`
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