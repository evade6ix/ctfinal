import express from "express";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();
const DISCOVERY_TTL_MS = 5_000;
const MAX_ORDER_PAGES = 200;

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

function cardTraderIdOf(item) {
  return finite(
    item?.product_id,
    item?.productId,
    item?.cardTraderId,
    item?.card_trader_id,
    item?.seller_product_id,
    item?.article?.product_id,
    item?.article?.id,
    item?.product?.id,
    item?.product?.product_id
  );
}

function quantityOf(item) {
  return finite(item?.quantity, item?.qty, item?.amount) || 0;
}

function nameOf(item) {
  return String(item?.name || item?.product?.name || "Unknown item").trim();
}

function conditionOf(item) {
  return (
    item?.condition ||
    item?.card_condition ||
    item?.attributes?.condition ||
    item?.properties?.condition ||
    item?.properties_hash?.condition ||
    item?.properties_hash?.card_condition ||
    null
  );
}

function truthyFoil(value) {
  if (value === true || value === 1) return true;

  const normalized = String(value || "").trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("nonfoil") ||
    normalized.includes("non-foil") ||
    normalized.includes("non foil") ||
    ["false", "0", "no", "regular", "standard"].includes(normalized)
  ) {
    return false;
  }

  return ["true", "1", "yes", "foil", "foiled"].includes(normalized);
}

function explicitFoilOf(item) {
  const values = [
    item?.isFoil,
    item?.is_foil,
    item?.foil,
    item?.properties?.mtg_foil,
    item?.properties?.foil,
    item?.properties_hash?.mtg_foil,
  ];

  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return truthyFoil(value);
    }
  }

  return null;
}

function textSaysFoil(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("nonfoil") ||
    normalized.includes("non-foil") ||
    normalized.includes("non foil")
  ) {
    return false;
  }
  return /(^|[^a-z])foil(?:ed)?([^a-z]|$)/.test(normalized);
}

function foilOf(item) {
  const explicit = explicitFoilOf(item);
  if (explicit !== null) return explicit;
  return textSaysFoil(item?.variant) || textSaysFoil(item?.description);
}

function isActiveZeroOrder(order) {
  const state = String(order?.state || order?.status || "").toLowerCase();
  const isZero =
    order?.via_cardtrader_zero === true || order?.viaCardTraderZero === true;
  return isZero && state === "hub_pending";
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
  if (listedItems.length > 0) {
    return { order, items: listedItems };
  }

  const orderId = order?.id;
  if (orderId == null) return { order, items: [] };

  const response = await client.get(`/orders/${orderId}`);
  const detailedOrder = response.data || order;
  return { order: detailedOrder, items: rawItems(detailedOrder) };
}

async function discoverMissingAllocations() {
  const client = ct();
  const sellerOrders = await fetchAllSellerOrders(client);
  const activeOrders = sellerOrders.filter(isActiveZeroOrder);
  const activeOrderIds = activeOrders
    .map((order) => (order?.id == null ? null : String(order.id)))
    .filter(Boolean);

  const existing = activeOrderIds.length
    ? await OrderAllocation.find({ orderId: { $in: activeOrderIds } })
        .select("orderId orderItemId")
        .lean()
    : [];

  const existingKeys = new Set(
    existing
      .filter((allocation) => allocation?.orderItemId != null)
      .map(
        (allocation) =>
          `${String(allocation.orderId)}:${Number(allocation.orderItemId)}`
      )
  );

  let discoveredLines = 0;
  let createdManualReviews = 0;
  let skippedExisting = 0;
  let skippedInvalid = 0;
  const failures = [];

  for (const listedOrder of activeOrders) {
    try {
      const { order, items } = await ensureOrderItems(client, listedOrder);
      const orderId = order?.id == null ? null : String(order.id);
      const orderCode = order?.code ? String(order.code) : null;

      if (!orderId) {
        skippedInvalid += items.length || 1;
        continue;
      }

      for (const item of items) {
        discoveredLines += 1;

        const orderItemId = orderItemIdOf(item);
        const quantity = quantityOf(item);
        const cardTraderId = cardTraderIdOf(item);

        if (!Number.isFinite(orderItemId) || quantity <= 0) {
          skippedInvalid += 1;
          continue;
        }

        const key = `${orderId}:${Number(orderItemId)}`;
        if (existingKeys.has(key)) {
          skippedExisting += 1;
          continue;
        }

        const payload = {
          source: "cardtrader",
          inventoryItemId: null,
          orderId,
          orderCode,
          orderItemId: Number(orderItemId),
          cardTraderId: Number.isFinite(cardTraderId)
            ? Number(cardTraderId)
            : null,
          requestedQuantity: quantity,
          fulfilledQuantity: 0,
          unfilled: quantity,
          name: nameOf(item),
          condition: conditionOf(item),
          isFoil: foilOf(item),
          pickedLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
          status: "manual_review",
          failureReason:
            "missing_allocation_record_discovered_from_active_zero_order",
          allocationMethod: "automatic",
        };

        try {
          const result = await OrderAllocation.updateOne(
            {
              source: "cardtrader",
              orderId,
              orderItemId: Number(orderItemId),
            },
            { $setOnInsert: payload },
            { upsert: true }
          );

          if (result.upsertedCount > 0) createdManualReviews += 1;
          else skippedExisting += 1;
          existingKeys.add(key);
        } catch (error) {
          if (error?.code === 11000) {
            skippedExisting += 1;
            existingKeys.add(key);
            continue;
          }

          failures.push({
            orderId,
            orderItemId,
            error: error?.message || String(error),
          });
        }
      }
    } catch (error) {
      failures.push({
        orderId: listedOrder?.id == null ? null : String(listedOrder.id),
        error: error?.response?.data || error?.message || String(error),
      });
    }
  }

  const result = {
    activeOrders: activeOrders.length,
    discoveredLines,
    createdManualReviews,
    skippedExisting,
    skippedInvalid,
    failures,
  };

  if (createdManualReviews > 0 || failures.length > 0) {
    console.log("🔎 [MANUAL ASSIGNMENTS] Missing-line discovery", result);
  }

  return result;
}

async function runDiscovery() {
  const now = Date.now();
  if (lastDiscoveryResult && now - lastDiscoveryAt < DISCOVERY_TTL_MS) {
    return lastDiscoveryResult;
  }

  if (!discoveryInFlight) {
    discoveryInFlight = discoverMissingAllocations()
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

// The existing manual-assignment GET route runs after this middleware. This
// middleware only materializes missing active Zero lines as empty manual-review
// records so the existing UI and assignment safety checks can handle them.
router.get("/", async (req, _res, next) => {
  try {
    req.manualAssignmentDiscovery = await runDiscovery();
  } catch (error) {
    console.warn("⚠️ [MANUAL ASSIGNMENTS] Missing-line discovery failed", {
      error: error?.response?.data || error?.message || String(error),
    });
  }

  return next();
});

export default router;
