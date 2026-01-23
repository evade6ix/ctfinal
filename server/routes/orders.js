// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";

const router = express.Router();

// simple in-memory cache to avoid spamming CT
let cachedOrders = null;
let cachedTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

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
        id: o.id,                 // 🔴 numeric id used everywhere
        code: o.code,             // string shown in table
        state: o.state,
        orderAs: o.order_as,
        buyer: o.buyer || null,
        size: o.size,
        date: extractedDate,
        sellerTotalCents: o.seller_total?.cents ?? null,
        sellerTotalCurrency: o.seller_total?.currency ?? null,
        formattedTotal: o.formatted_total ?? null,
      };
    });

    cachedOrders = mapped;
    cachedTime = Date.now();

    res.json(mapped);
  } catch (err) {
    console.error("❌ Error fetching orders:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

export default router;
