// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

// =======================================================
// GET /api/orders
//  - Lists orders with allocated flag + ITEMS + imageUrl
// =======================================================
router.get("/", async (req, res) => {
  try {
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

    // 🔥 Build full orders INCLUDING ITEMS + imageUrl
    const mapped = await Promise.all(
      allOrders.map(async (o) => {
        //
        // ============ CREATED_AT LOGIC (unchanged) ============
        //
        let rawCreated = null;

        if (Array.isArray(o.order_items) && o.order_items.length > 0) {
          rawCreated = o.order_items[0].created_at || null;
        }

        if (!rawCreated && o.code && o.code.length >= 8) {
          const d = o.code.substring(0, 8);
          const year = d.substring(0, 4);
          const month = d.substring(4, 6);
          const day = d.substring(6, 8);
          rawCreated = `${year}-${month}-${day}T00:00:00.000Z`;
        }

        //
        // ============ EXTRACT SIMPLE LINE ITEMS FROM CT ============
        //
        let rawItems = [];
        if (Array.isArray(o.order_items)) rawItems = o.order_items;
        else if (Array.isArray(o.items)) rawItems = o.items;
        else if (o.order_items?.data) rawItems = o.order_items.data;
        else if (o.items?.data) rawItems = o.items.data;

        const baseItems = rawItems.map((it) => ({
          id: it.id,
          cardTraderId: it.product_id ?? null,
          name: it.name || "Unknown item",
          quantity: it.quantity ?? 0,
        }));

        //
        // ============ LOOK UP IMAGEURL FROM MONGO ============
        //
        const ctIds = baseItems
          .map((i) => Number(i.cardTraderId))
          .filter((x) => Number.isFinite(x));

        const invItems = await InventoryItem.find({
          cardTraderId: { $in: ctIds },
        }).lean();

        const invMap = new Map();
        for (const inv of invItems) {
          invMap.set(Number(inv.cardTraderId), inv);
        }

        const finalItems = baseItems.map((it) => {
          const inv = invMap.get(Number(it.cardTraderId));
          let imageUrl = null;

          if (inv?.imageUrl) {
            imageUrl = inv.imageUrl;
          } else if (inv?.blueprintId) {
            imageUrl = `https://img.cardtrader.com/blueprints/${inv.blueprintId}/front.jpg`;
          }

          return {
            ...it,
            imageUrl,
          };
        });

        //
        // RETURN ORDER WITH ITEMS + IMAGEURLs
        //
        return {
          id: o.id,
          code: o.code,
          state: o.state,
          orderAs: o.order_as,
          buyer: o.buyer || null,
          size: o.size,
          createdAt: rawCreated,
          sellerTotalCents: o.seller_total?.cents ?? null,
          sellerTotalCurrency: o.seller_total?.currency ?? null,
          formattedTotal: o.formatted_total ?? null,

          items: finalItems, // 🔥 IMPORTANT: YOUR IMAGES LIVE HERE
        };
      })
    );

    // ================================================================
    // Attach allocation flags (unchanged)
    // ================================================================
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

    res.json(mappedWithFlag);
  } catch (err) {
    console.error("❌ Error fetching orders:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// =======================================================
// POST /api/orders/sync  (unchanged)
// =======================================================
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

    // Debug:
    const stateCounts = {};
    for (const o of allOrders) {
      const s = o.state ?? o.status ?? "UNKNOWN";
      stateCounts[s] = (stateCounts[s] || 0) + 1;
    }
    console.log("DEBUG /api/orders/sync states:", stateCounts);
    console.log("DEBUG /api/orders/sync sample order:", allOrders[0]);

    const eligible = allOrders.filter((o) => {
      const state = String(o.state || o.status || "").toLowerCase();
      const isZero = !!o.via_cardtrader_zero;

      if (isZero) return state === "hub_pending";
      else return state === "paid";
    });

    let triggered = 0;
    let skippedAlreadyAllocated = 0;
    let failed = 0;

    for (const o of eligible) {
      const orderIdStr = String(o.id);

      const hasAnyAlloc = await OrderAllocation.exists({ orderId: orderIdStr });
      if (hasAnyAlloc) {
        skippedAlreadyAllocated++;
        continue;
      }

      const url = `http://localhost:${process.env.PORT || 3000}/api/order-articles/${o.id}`;
      console.log(`🔁 [ORDERS] Allocating order ${orderIdStr} via ${url}`);

      try {
        const resp = await fetch(url);
        const raw = await resp.text().catch(() => "");

        if (!resp.ok) {
          console.error(
            "❌ Failed to allocate order via order-articles",
            o.id,
            resp.status,
            raw.slice(0, 300)
          );
          failed++;
          continue;
        }

        triggered++;
      } catch (err) {
        console.error(
          "❌ Error allocating order via order-articles",
          o.id,
          err?.message || err
        );
        failed++;
      }
    }

    const summary = {
      ok: true,
      fetchedOrders: allOrders.length,
      eligibleOrders: eligible.length,
      processedThisRun: triggered + skippedAlreadyAllocated + failed,
      triggered,
      skippedAlreadyAllocated,
      failed,
    };

    console.log("✅ [ORDERS] sync summary", summary);
    res.json(summary);
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
