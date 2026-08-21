// server/routes/orders.js
import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { recordCompletedOperation } from "../services/operationRuns.js";

const router = express.Router();

function getOrderCreatedAt(o) {
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

  return rawCreated;
}

function getRawItems(o) {
  if (Array.isArray(o.order_items)) return o.order_items;
  if (Array.isArray(o.items)) return o.items;
  if (o.order_items?.data) return o.order_items.data;
  if (o.items?.data) return o.items.data;
  return [];
}

function getTorontoStartOfToday() {
  const torontoNow = new Date(
    new Date().toLocaleString("en-CA", {
      timeZone: "America/Toronto",
    })
  );

  torontoNow.setHours(0, 0, 0, 0);
  return torontoNow;
}

function getOrderSyncCutoff(rawOverride) {
  const raw = rawOverride || process.env.ORDER_SYNC_CUTOFF;

  if (raw) {
    const cutoff = new Date(raw);

    if (Number.isNaN(cutoff.getTime())) {
      return {
        ok: false,
        cutoff: null,
        raw,
      };
    }

    return {
      ok: true,
      cutoff,
      source: rawOverride ? "request" : "ORDER_SYNC_CUTOFF",
      raw,
    };
  }

  return {
    ok: true,
    cutoff: getTorontoStartOfToday(),
    source: "today_toronto_default",
    raw: null,
  };
}

function isCardTraderOrderEligibleForInventoryDeduction(o) {
  const state = String(o?.state || o?.status || "").toLowerCase();
  const isZero = !!o?.via_cardtrader_zero;

  if (isZero) return state === "hub_pending";
  return state === "paid";
}

function getCardTraderEligibilityReason(o) {
  const state = String(o?.state || o?.status || "").toLowerCase();
  const isZero = !!o?.via_cardtrader_zero;

  if (isZero && state !== "hub_pending") {
    return "cardtrader_zero_not_hub_pending";
  }

  if (!isZero && state !== "paid") {
    return "standard_order_not_paid";
  }

  return null;
}

async function fetchAllSellerOrders() {
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

  return allOrders;
}

function imageUrlForInventoryItem(inv) {
  if (inv?.imageUrl) return inv.imageUrl;
  if (inv?.blueprintId) {
    return `https://img.cardtrader.com/blueprints/${inv.blueprintId}/front.jpg`;
  }
  return null;
}

async function fetchInventoryMapForOrders(mappedOrders) {
  const ctIds = [
    ...new Set(
      mappedOrders
        .flatMap((order) => order.items || [])
        .map((item) => Number(item.cardTraderId))
        .filter((x) => Number.isFinite(x))
    ),
  ];

  if (ctIds.length === 0) return new Map();

  try {
    const invItems = await InventoryItem.find({
      cardTraderId: { $in: ctIds },
    }).lean();

    const invMap = new Map();
    for (const inv of invItems) {
      invMap.set(Number(inv.cardTraderId), inv);
    }

    return invMap;
  } catch (err) {
    console.error(
      "⚠️ /api/orders inventory decoration skipped because Mongo lookup failed:",
      err?.message || err
    );
    return new Map();
  }
}

async function fetchAllocationFlagsForOrders(mappedOrders) {
  const orderIdStrings = mappedOrders.map((o) => String(o.id));

  if (orderIdStrings.length === 0) {
    return {
      allocatedSet: new Set(),
      manualReviewSet: new Set(),
    };
  }

  try {
    const allocations = await OrderAllocation.find(
      { orderId: { $in: orderIdStrings } },
      "orderId status"
    ).lean();

    return {
      allocatedSet: new Set(
        allocations
          .filter((a) => a.status === "allocated")
          .map((a) => String(a.orderId))
      ),
      manualReviewSet: new Set(
        allocations
          .filter((a) => a.status === "manual_review")
          .map((a) => String(a.orderId))
      ),
    };
  } catch (err) {
    console.error(
      "⚠️ /api/orders allocation flags skipped because Mongo lookup failed:",
      err?.message || err
    );

    return {
      allocatedSet: new Set(),
      manualReviewSet: new Set(),
    };
  }
}

export async function reconcileCardTraderOrderById(orderId) {
  const orderIdStr = String(orderId);
  const url = `http://localhost:${
    process.env.PORT || 3000
  }/api/order-allocations/reconcile-order/${orderIdStr}`;

  console.log(
    `🔁 [ORDERS] Reconciling safe allocations for order ${orderIdStr} via ${url}`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  const raw = await resp.text().catch(() => "");
  let parsed = null;

  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!resp.ok) {
    return {
      orderId: orderIdStr,
      ok: false,
      status: resp.status,
      details: raw.slice(0, 300),
    };
  }

  return {
    orderId: orderIdStr,
    ok: true,
    result: parsed,
  };
}

export async function syncEligibleCardTraderSellerOrders(options = {}) {
  const allOrders = await fetchAllSellerOrders();

  const stateCounts = {};
  for (const o of allOrders) {
    const s = o.state ?? o.status ?? "UNKNOWN";
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  }

  console.log("DEBUG /api/orders/sync states:", stateCounts);

  const cutoffInfo = getOrderSyncCutoff(options.cutoff);

  if (!cutoffInfo.ok) {
    return {
      ok: false,
      status: 400,
      error: "Invalid ORDER_SYNC_CUTOFF env value",
      value: cutoffInfo.raw,
    };
  }

  const cutoff = cutoffInfo.cutoff;
  let skippedBeforeCutoff = 0;
  let skippedMissingCreatedAt = 0;
  let skippedIneligibleState = 0;

  const eligible = allOrders.filter((o) => {
    if (!isCardTraderOrderEligibleForInventoryDeduction(o)) {
      skippedIneligibleState++;
      return false;
    }

    if (cutoff) {
      const rawCreated = getOrderCreatedAt(o);
      const createdAt = rawCreated ? new Date(rawCreated) : null;

      if (!createdAt || Number.isNaN(createdAt.getTime())) {
        skippedMissingCreatedAt++;
        return false;
      }

      if (createdAt < cutoff) {
        skippedBeforeCutoff++;
        return false;
      }
    }

    return true;
  });

  let reconciled = 0;
  let failed = 0;
  const results = [];

  for (const o of eligible) {
    const result = await reconcileCardTraderOrderById(o.id);

    if (!result.ok) {
      failed++;
    } else {
      reconciled++;
    }

    results.push(result);
  }

  return {
    ok: true,
    fetchedOrders: allOrders.length,
    eligibleOrders: eligible.length,
    reconciled,
    failed,
    cutoff: cutoff ? cutoff.toISOString() : null,
    cutoffSource: cutoffInfo.source,
    skippedBeforeCutoff,
    skippedMissingCreatedAt,
    skippedIneligibleState,
    deletedAllocationsCount: 0,
    deletedStaleAllocationsCount: 0,
    results,
  };
}

export async function syncCardTraderWebhookOrder(order) {
  const orderId = order?.id;

  if (!orderId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_order_id",
    };
  }

  if (!isCardTraderOrderEligibleForInventoryDeduction(order)) {
    return {
      ok: true,
      skipped: true,
      orderId: String(orderId),
      reason: getCardTraderEligibilityReason(order),
      state: order?.state || order?.status || null,
      viaCardTraderZero: !!order?.via_cardtrader_zero,
    };
  }

  const cutoffInfo = getOrderSyncCutoff();

  if (!cutoffInfo.ok) {
    return {
      ok: false,
      skipped: true,
      orderId: String(orderId),
      reason: "invalid_order_sync_cutoff",
      value: cutoffInfo.raw,
    };
  }

  const rawCreated = getOrderCreatedAt(order);
  const createdAt = rawCreated ? new Date(rawCreated) : null;

  if (
    cutoffInfo.cutoff &&
    (!createdAt || Number.isNaN(createdAt.getTime()) || createdAt < cutoffInfo.cutoff)
  ) {
    return {
      ok: true,
      skipped: true,
      orderId: String(orderId),
      reason: "before_cutoff_or_missing_created_at",
      cutoff: cutoffInfo.cutoff.toISOString(),
      createdAt: rawCreated,
    };
  }

  return reconcileCardTraderOrderById(orderId);
}

router.get("/", async (req, res) => {
  try {
    const allOrders = await fetchAllSellerOrders();

    console.log("Fetched", allOrders.length, "orders");

    const mappedBase = allOrders.map((o) => {
      const rawCreated = getOrderCreatedAt(o);
      const rawItems = getRawItems(o);

      const baseItems = rawItems.map((it) => ({
        id: it.id,
        cardTraderId: it.product_id ?? null,
        name: it.name || "Unknown item",
        quantity: it.quantity ?? 0,
      }));

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
        viaCardTraderZero: !!o.via_cardtrader_zero,
        items: baseItems,
      };
    });

    const invMap = await fetchInventoryMapForOrders(mappedBase);

    const mapped = mappedBase.map((order) => ({
      ...order,
      items: (order.items || []).map((it) => {
        const inv = invMap.get(Number(it.cardTraderId));
        return {
          ...it,
          imageUrl: imageUrlForInventoryItem(inv),
        };
      }),
    }));

    const { allocatedSet, manualReviewSet } = await fetchAllocationFlagsForOrders(
      mapped
    );

    const mappedWithFlags = mapped.map((o) => ({
      ...o,
      allocated: allocatedSet.has(String(o.id)),
      manualReview: manualReviewSet.has(String(o.id)),
    }));

    res.json(mappedWithFlags);
  } catch (err) {
    console.error("❌ Error fetching orders:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * POST /api/orders/sync
 *
 * SAFE RULES:
 * - No allocation deletion here.
 * - No stale cleanup here.
 * - Only reconciles eligible active orders.
 * - ORDER_SYNC_CUTOFF prevents old orders from touching rebuilt inventory.
 *
 * Set in .env after a wipe/reset:
 * ORDER_SYNC_CUTOFF=2026-05-02T00:00:00.000Z
 *
 * If ORDER_SYNC_CUTOFF is missing, the safe default is today at midnight Toronto.
 */
router.post("/sync", async (req, res) => {
  const startedAt = new Date();
  try {
    const summary = await syncEligibleCardTraderSellerOrders({
      cutoff: req.body?.cutoff || req.query?.cutoff,
    });

    if (!summary.ok && summary.status === 400) {
      return res.status(400).json(summary);
    }

    console.log("✅ [ORDERS] safe sync summary", summary);
    if (req.get("X-CTFinal-Trigger") !== "auto-worker") {
      await recordCompletedOperation({
        kind: "order-sync",
        label: "Manual CardTrader order synchronization",
        source: "cardtrader",
        trigger: "manual",
        initiatedBy: String(req.body?.initiatedBy || "local"),
        startedAt,
        status: summary.failed ? "completed_with_errors" : "completed",
        summary: {
          fetchedOrders: summary.fetchedOrders,
          eligibleOrders: summary.eligibleOrders,
          reconciled: summary.reconciled,
          failed: summary.failed,
          cutoff: summary.cutoff,
        },
        errors: (summary.results || []).filter((result) => !result.ok),
      });
    }
    res.json(summary);
  } catch (err) {
    console.error("❌ /api/orders/sync failed:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
