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
    // Fetch from your normalized orders endpoint
    const r = await fetch("http://localhost:3000/api/orders");
    const orders = await r.json();

    if (!Array.isArray(orders)) {
      return res.json([]);
    }

    // helper → get week start (Monday) from createdAt
    const getWeekId = (createdAt) => {
      if (!createdAt) return "unknown";

      const d = new Date(createdAt);
      if (isNaN(d.getTime())) return "unknown";

      // Convert to Monday-based week (current behavior)
      const day = d.getDay(); // Sun=0, Mon=1...
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);

      return monday.toISOString().substring(0, 10); // YYYY-MM-DD
    };

    const weeks = {};

    for (const o of orders) {
      // 🔑 Use the new normalized field
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

    res.json(output);
  } catch (err) {
    console.error("❌ weekly error:", err);
    res.status(500).json({ error: "Failed to compute weekly shipments" });
  }
});

export default router;
