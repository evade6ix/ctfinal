import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();
const DISCOVERY_TTL_MS = 5_000;
const MAX_ORDER_PAGES = 200;
const AUTO_LOCK_TTL_MS = 10 * 60 * 1000;

let lastDiscoveryAt = 0;
let lastDiscoveryResult = null;
let discoveryInFlight = null;

function finite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rawItems(order) {
  if (Array.isArray(order?.order_items)) return order.order_items;
  if (Array.isArray(order?.items)) return order.items;
  if (Array.isArray(order?.order_items?.data)) return order.order_items.data;
  if (Array.isArray(order?.items?.data)) return order.items.data;
  return [];
}

function orderItemIdOf(item) {
  return finite(
    item?.id,
    item?.order_item_id,
    item?.orderItemId,
    item?.seller_order_item_id,
    item?.line_id,
    item?.lineItemId
  );
}

function quantityOf(item) {
  return finite(item?.quantity, item?.qty, item?.amount) || 0;
}

function isActiveZeroOrder(order) {
  const state = String(order?.state || order?.status || "").toLowerCase();
  const isZero =
    order?.via_cardtrader_zero === true || order?.viaCardTraderZero === true;
  return isZero && state === "hub_pending";
}

function getOrderCreatedAt(order) {
  const items = rawItems(order);
  const itemCreatedAt = items[0]?.created_at || items[0]?.createdAt || null;
  if (itemCreatedAt) return itemCreatedAt;

  const code = String(order?.code || "");
  if (/^\d{8}/.test(code)) {
    return `${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(
      6,
      8
    )}T00:00:00.000Z`;
  }

  return order?.created_at || order?.createdAt || null;
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

function getOrderSyncCutoff() {
  const raw = process.env.ORDER_SYNC_CUTOFF;
  if (!raw) return getTorontoStartOfToday();

  const cutoff = new Date(raw);
  if (Number.isNaN(cutoff.getTime())) {
    console.warn(
      "⚠️ [MANUAL ASSIGNMENTS] Invalid ORDER_SYNC_CUTOFF; using today",
      raw
    );
    return getTorontoStartOfToday();
  }

  return cutoff;
}

function isAfterCutoff(order, cutoff) {
  const rawCreatedAt = getOrderCreatedAt(order);
  if (!rawCreatedAt) return false;

  const createdAt = new Date(rawCreatedAt);
  return !Number.isNaN(createdAt.getTime()) && createdAt >= cutoff;
}

function isRetryableManualReview(allocation) {
  if (!allocation) return true;

  const emptyManualReview =
    allocation.status === "manual_review" &&
    Number(allocation.fulfilledQuantity || 0) === 0 &&
    (!Array.isArray(allocation.pickedLocations) ||
      allocation.pickedLocations.length === 0) &&
    allocation.picked !== true;

  if (emptyManualReview) return true;

  const staleAutoLock =
    allocation.status === "manual_review" &&
    allocation.picked === true &&
    String(allocation.pickedBy || "").startsWith("AutoAllocationLock:") &&
    (!allocation.pickedAt ||
      Date.now() - new Date(allocation.pickedAt).getTime() > AUTO_LOCK_TTL_MS);

  return staleAutoLock;
}

async function fetchAllSellerOrders(client) {
  const allOrders = [];
  const limit = 50;

  for (let page = 1; page <= MAX_ORDER_PAGES; page += 1) {
    const response = await client.get("/orders", {
      params: {
        order_as: "seller",
        sort: "date.desc",
        page,
        limit,
      },
    });

    const batch = Array.isArray(response.data) ? response.data : [];
    if (!batch.length) break;
    allOrders.push(...batch);
    if (batch.length < limit) break;
  }

  return allOrders;
}

async function ensureOrderItems(client, order) {
  const listedItems = rawItems(order);
  if (listedItems.length > 0) return { order, items: listedItems };

  const orderId = order?.id;
  if (orderId == null) return { order, items: [] };

  const response = await client.get(`/orders/${orderId}`);
  const detailedOrder = response.data || order;
  return { order: detailedOrder, items: rawItems(detailedOrder) };
}

async function reconcileOrder(orderId) {
  const baseUrl =
    process.env.INTERNAL_API_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;
  const response = await fetch(
    `${baseUrl}/api/order-allocations/reconcile-order/${orderId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );

  const raw = await response.text().catch(() => "");
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { raw: raw.slice(0, 500) };
  }

  if (!response.ok) {
    const error = new Error(
      body?.details || body?.error || `reconcile_failed_${response.status}`
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function discoverAndReconcile() {
  const client = ct();
  const cutoff = getOrderSyncCutoff();
  const sellerOrders = await fetchAllSellerOrders(client);
  const activeOrders = sellerOrders.filter(
    (order) => isActiveZeroOrder(order) && isAfterCutoff(order, cutoff)
  );
  const activeOrderIds = activeOrders
    .map((order) => (order?.id == null ? null : String(order.id)))
    .filter(Boolean);

  const existing = activeOrderIds.length
    ? await OrderAllocation.find({ orderId: { $in: activeOrderIds } })
        .select(
          "orderId orderItemId status fulfilledQuantity pickedLocations picked pickedAt pickedBy"
        )
        .lean()
    : [];

  const allocationByLine = new Map(
    existing
      .filter((allocation) => allocation?.orderItemId != null)
      .map((allocation) => [
        `${String(allocation.orderId)}:${Number(allocation.orderItemId)}`,
        allocation,
      ])
  );

  let discoveredLines = 0;
  let ordersNeedingReconcile = 0;
  let reconciledOrders = 0;
  let alreadyResolvedOrders = 0;
  let skippedInvalid = 0;
  const results = [];
  const failures = [];

  for (const listedOrder of activeOrders) {
    try {
      const { order, items } = await ensureOrderItems(client, listedOrder);
      const orderId = order?.id == null ? null : String(order.id);

      if (!orderId) {
        skippedInvalid += items.length || 1;
        continue;
      }

      let needsReconcile = false;

      for (const item of items) {
        discoveredLines += 1;
        const orderItemId = orderItemIdOf(item);
        const quantity = quantityOf(item);

        if (!Number.isFinite(orderItemId) || quantity <= 0) {
          skippedInvalid += 1;
          continue;
        }

        const allocation = allocationByLine.get(
          `${orderId}:${Number(orderItemId)}`
        );
        if (isRetryableManualReview(allocation)) needsReconcile = true;
      }

      if (!needsReconcile) {
        alreadyResolvedOrders += 1;
        continue;
      }

      ordersNeedingReconcile += 1;
      const result = await reconcileOrder(orderId);
      reconciledOrders += 1;
      results.push({ orderId, result });
    } catch (error) {
      failures.push({
        orderId:
          listedOrder?.id == null ? null : String(listedOrder.id),
        status: error?.status || error?.response?.status || null,
        error:
          error?.body ||
          error?.response?.data ||
          error?.message ||
          String(error),
      });
    }
  }

  const result = {
    cutoff: cutoff.toISOString(),
    activeOrders: activeOrders.length,
    discoveredLines,
    ordersNeedingReconcile,
    reconciledOrders,
    alreadyResolvedOrders,
    skippedInvalid,
    results,
    failures,
  };

  if (ordersNeedingReconcile > 0 || failures.length > 0) {
    console.log(
      "🔎 [MANUAL ASSIGNMENTS] Automatic reconciliation before exception list",
      result
    );
  }

  return result;
}

async function runDiscovery() {
  const now = Date.now();
  if (lastDiscoveryResult && now - lastDiscoveryAt < DISCOVERY_TTL_MS) {
    return lastDiscoveryResult;
  }

  if (!discoveryInFlight) {
    discoveryInFlight = discoverAndReconcile()
      .then((result) => {
        lastDiscoveryAt = Date.now();
        lastDiscoveryResult = result;
        return result;
      })
      .finally(() => {
        discoveryInFlight = null;
      });
  }

  return discoveryInFlight;
}

// The exception page never creates manual-review records directly. It first
// runs the same automatic reconciliation used by normal sales, then the next
// list middleware returns only the lines that still genuinely need attention.
router.get("/", async (req, _res, next) => {
  try {
    req.manualAssignmentDiscovery = await runDiscovery();
  } catch (error) {
    console.warn(
      "⚠️ [MANUAL ASSIGNMENTS] Automatic pre-list reconciliation failed",
      {
        error: error?.response?.data || error?.message || String(error),
      }
    );
  }

  return next();
});

export default router;
