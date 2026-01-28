// server/routes/orders-weekly.js
import express from "express";

const router = express.Router();

/**
 * GET /api/orders-weekly
 * Groups seller orders by week using the normalized createdAt field.
 * Relies on /api/orders returning { createdAt: ISO string }.
 */
router.get("/", async (req, res) => {
  try {
    // Use the same port the app is actually listening on
    const port = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${port}/api/orders`;

    // Fetch from your normalized orders endpoint
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

    // helper → get week start (Monday) from createdAt
    const getWeekId = (createdAt) => {
      if (!createdAt) return "unknown";

      const d = new Date(createdAt);
      if (isNaN(d.getTime())) return "unknown";

      // Convert to Monday-based week
      const day = d.getDay(); // Sun=0, Mon=1...
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);

      return monday.toISOString().substring(0, 10); // YYYY-MM-DD
    };

    const weeks = {};

    for (const o of orders) {
      // 🔑 Use the normalized createdAt field
      const weekId = getWeekId(o.createdAt);

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

    // Human-friendly total string
    output.forEach((w) => {
      w.totalValue = (w.totalValueCents / 100).toFixed(2);
    });

    console.log(
      `[/api/orders-weekly] computed ${output.length} weeks from ${
        orders.length
      } orders`
    );

    res.json(output);
  } catch (err) {
    console.error("❌ weekly error:", err);
    res
      .status(500)
      .json({ error: "Failed to compute weekly shipments", details: err.message });
  }
});

export default router;
