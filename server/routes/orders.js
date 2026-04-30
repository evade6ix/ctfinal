// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

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

    const mapped = await Promise.all(
      allOrders.map(async (o) => {
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
          items: finalItems,
        };
      })
    );

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
      return state === "paid";
    });

    const TERMINAL_STATES = new Set([
      "sent",
      "arrived",
      "done",
      "canceled",
      "lost",
      "closed",
    ]);

    const terminalOrders = allOrders.filter((o) => {
      const state = String(o.state || o.status || "").toLowerCase();
      return TERMINAL_STATES.has(state);
    });

    const terminalOrderIds = terminalOrders
      .map((o) => String(o.id))
      .filter(Boolean);

    const terminalOrderCodes = terminalOrders
      .map((o) => (o.code ? String(o.code) : null))
      .filter(Boolean);

    let deletedAllocationsCount = 0;

    if (terminalOrderIds.length || terminalOrderCodes.length) {
      const deleteResult = await OrderAllocation.deleteMany({
        $or: [
          ...(terminalOrderIds.length
            ? [{ orderId: { $in: terminalOrderIds } }]
            : []),
          ...(terminalOrderCodes.length
            ? [{ orderCode: { $in: terminalOrderCodes } }]
            : []),
        ],
      });

      deletedAllocationsCount = deleteResult?.deletedCount || 0;

      console.log(
        `🧹 [ORDERS] Deleted ${deletedAllocationsCount} allocations for ${terminalOrders.length} terminal orders`
      );
    }

    // Stale cleanup:
    // Delete old allocations for orders CardTrader no longer returns,
    // while keeping current active eligible orders safe.
    const activeOrderIds = eligible.map((o) => String(o.id));
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const staleDeleteResult = await OrderAllocation.deleteMany({
      orderId: { $nin: activeOrderIds },
      createdAt: { $lt: tenDaysAgo },
    });

    const deletedStaleAllocationsCount = staleDeleteResult?.deletedCount || 0;

    console.log(
      `🧹 [ORDERS] Deleted ${deletedStaleAllocationsCount} stale allocations older than 10 days`
    );

    let triggered = 0;
    let failed = 0;

    for (const o of eligible) {
      const orderIdStr = String(o.id);
      const url = `http://localhost:${
        process.env.PORT || 3000
      }/api/order-allocations/reconcile-order/${o.id}`;

      console.log(
        `🔁 [ORDERS] Reconciling allocations for order ${orderIdStr} via ${url}`
      );

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        const raw = await resp.text().catch(() => "");

        if (!resp.ok) {
          console.error(
            "❌ Failed to reconcile order via order-allocations",
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
          "❌ Error reconciling order via order-allocations",
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
      processedThisRun: triggered + failed,
      reconciled: triggered,
      failed,
      deletedAllocationsCount,
      deletedStaleAllocationsCount,
    };

    console.log("✅ [ORDERS] sync summary", summary);
    res.json(summary);
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;