import express from "express";

const router = express.Router();

/**
 * GET /api/orders-weekly
 * Groups seller orders by week using the extracted date field.
 * Requires the main /api/orders to already return { date: "YYYY-MM-DD" }.
 */
router.get("/", async (req, res) => {
  try {
    // Fetch from your cached orders endpoint
    const r = await fetch("http://localhost:3000/api/orders");
    const orders = await r.json();

    if (!Array.isArray(orders)) {
      return res.json([]);
    }

    // helper → get week start (Monday)
    const getWeekId = (dateStr) => {
      if (!dateStr) return "unknown";

      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return "unknown";

      // Convert to Monday-based week
      const day = d.getDay(); // Sun=0, Mon=1...
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d.setDate(diff));

      return monday.toISOString().substring(0, 10); // YYYY-MM-DD
    };

    // Group by week
    const weeks = {};

    for (const o of orders) {
      const weekId = getWeekId(o.date);

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

    // Convert to clean array sorted by week desc
    const output = Object.values(weeks).sort(
      (a, b) => new Date(b.weekStart) - new Date(a.weekStart)
    );

    // Add formatted totals
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
