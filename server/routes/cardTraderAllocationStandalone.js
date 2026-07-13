import express from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();
const activeLines = new Set();
const LOCK_TTL_MS = 10 * 60 * 1000;

function supportsTransactions() {
  const type = String(
    mongoose.connection?.client?.topology?.description?.type || ""
  );
  return type.includes("ReplicaSet") || type.includes("Sharded");
}

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
  if (value === false || value === 0 || value == null) return false;

  const normalized = String(value).trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("nonfoil") ||
    normalized.includes("non-foil") ||
    normalized.includes("non foil") ||
    ["false", "0", "no", "regular", "standard", "normal"].includes(
      normalized
    )
  ) {
    return false;
  }

  return ["true", "1", "yes", "foil", "foiled"].includes(normalized);
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
  for (const value of [
    item?.isFoil,
    item?.is_foil,
    item?.foil,
    item?.properties?.mtg_foil,
    item?.properties?.foil,
    item?.properties_hash?.mtg_foil,
  ]) {
    if (value !== undefined && value !== null && value !== "") {
      return truthyFoil(value);
    }
  }

  return textSaysFoil(item?.variant) || textSaysFoil(item?.description);
}

function sourceFilter() {
  return { $or: [{ source: "cardtrader" }, { source: { $exists: false } }] };
}

function allocationFilter(orderId, orderItemId) {
  return {
    $and: [
      sourceFilter(),
      { orderId: String(orderId) },
      { orderItemId: Number(orderItemId) },
    ],
  };
}

function isRetryableManualReview(allocation) {
  return (
    allocation?.status === "manual_review" &&
    Number(allocation?.fulfilledQuantity || 0) === 0 &&
    (!Array.isArray(allocation?.pickedLocations) ||
      allocation.pickedLocations.length === 0) &&
    allocation?.picked !== true
  );
}

function isStaleAutoLock(allocation) {
  return (
    allocation?.status === "manual_review" &&
    allocation?.picked === true &&
    String(allocation?.pickedBy || "").startsWith("AutoAllocationLock:") &&
    (!allocation?.pickedAt ||
      Date.now() - new Date(allocation.pickedAt).getTime() > LOCK_TTL_MS)
  );
}

function assignedQuantity(item) {
  return (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
    0
  );
}

function locationData(location) {
  return {
    bin: location?.bin?._id || location?.bin,
    row: Number(location?.row),
    quantity: Number(location?.quantity || 0),
  };
}

function allocationSnapshot(allocation) {
  return {
    source: allocation.source || "cardtrader",
    inventoryItemId: allocation.inventoryItemId || null,
    orderId: String(allocation.orderId),
    orderCode: allocation.orderCode || null,
    orderItemId: Number(allocation.orderItemId),
    cardTraderId:
      allocation.cardTraderId == null ? null : Number(allocation.cardTraderId),
    requestedQuantity: Number(allocation.requestedQuantity || 0),
    fulfilledQuantity: Number(allocation.fulfilledQuantity || 0),
    unfilled: Number(allocation.unfilled || 0),
    name: allocation.name || "Unknown item",
    condition: allocation.condition || null,
    isFoil: allocation.isFoil === true,
    pickedLocations: (allocation.pickedLocations || []).map(locationData),
    picked: allocation.picked === true,
    pickedAt: allocation.pickedAt || null,
    pickedBy: allocation.pickedBy || null,
    status: allocation.status,
    failureReason: allocation.failureReason || null,
    allocationMethod: allocation.allocationMethod || "automatic",
    manualInventoryItemIds: allocation.manualInventoryItemIds || [],
    manuallyAssignedAt: allocation.manuallyAssignedAt || null,
    manuallyAssignedBy: allocation.manuallyAssignedBy || null,
  };
}

function reviewPayload({
  orderId,
  orderCode,
  orderItemId,
  cardTraderId,
  quantity,
  item,
  reason,
}) {
  return {
    source: "cardtrader",
    inventoryItemId: null,
    orderId: String(orderId),
    orderCode: orderCode || null,
    orderItemId: Number(orderItemId),
    cardTraderId: Number(cardTraderId),
    requestedQuantity: Number(quantity),
    fulfilledQuantity: 0,
    unfilled: Number(quantity),
    name: nameOf(item),
    condition: conditionOf(item),
    isFoil: foilOf(item),
    pickedLocations: [],
    picked: false,
    pickedAt: null,
    pickedBy: null,
    status: "manual_review",
    failureReason: reason,
    allocationMethod: "automatic",
    manualInventoryItemIds: [],
    manuallyAssignedAt: null,
    manuallyAssignedBy: null,
  };
}

function buildPlan(items, requestedQuantity) {
  let remaining = Number(requestedQuantity || 0);
  const steps = [];
  const pickedLocations = [];

  for (const item of [...items].sort(
    (a, b) => assignedQuantity(b) - assignedQuantity(a)
  )) {
    if (remaining <= 0) break;

    const allocation = allocateFromBins(item.locations || [], remaining);
    const pickedQuantity = (allocation.pickedLocations || []).reduce(
      (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
      0
    );

    if (pickedQuantity <= 0) continue;

    steps.push({
      item,
      pickedQuantity,
      remainingLocations: (allocation.remainingLocations || []).map(locationData),
    });
    pickedLocations.push(
      ...(allocation.pickedLocations || []).map(locationData)
    );
    remaining -= pickedQuantity;
  }

  return {
    steps,
    pickedLocations,
    fulfilledQuantity: Math.max(0, Number(requestedQuantity || 0) - remaining),
    unfilled: Math.max(0, remaining),
  };
}

async function ensureReviewRecord(payload) {
  let allocation = await OrderAllocation.findOne(
    allocationFilter(payload.orderId, payload.orderItemId)
  );

  if (allocation) return { allocation, created: false };

  try {
    allocation = await OrderAllocation.create(payload);
    return { allocation, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    allocation = await OrderAllocation.findOne(
      allocationFilter(payload.orderId, payload.orderItemId)
    );
    if (!allocation) throw error;
    return { allocation, created: false };
  }
}

async function restoreAllocation(allocationId, snapshot) {
  await OrderAllocation.updateOne(
    { _id: allocationId },
    {
      $set: snapshot,
    }
  );
}

async function restoreInventory(appliedSnapshots) {
  const rollbackFailures = [];

  for (const snapshot of [...appliedSnapshots].reverse()) {
    const result = await InventoryItem.updateOne(
      { _id: snapshot.id, __v: snapshot.version + 1 },
      {
        $set: {
          locations: snapshot.locations,
          totalQuantity: snapshot.totalQuantity,
          __v: snapshot.version,
        },
      }
    );

    if (Number(result.modifiedCount || result.nModified || 0) !== 1) {
      rollbackFailures.push(snapshot.id.toString());
    }
  }

  return rollbackFailures;
}

async function syncManaPool(inventoryItemIds, context) {
  const ids = [...new Set((inventoryItemIds || []).map(String).filter(Boolean))];
  if (!ids.length) return null;

  const items = await InventoryItem.find({ _id: { $in: ids } });
  if (!items.length) {
    return {
      ok: false,
      error: "inventory_items_missing_after_allocation",
      inventoryItemIds: ids,
    };
  }

  try {
    const result = await syncInventoryItemsToManaPool(items, { livePush: true });
    const failed =
      !result?.ok ||
      result?.payloadCount === 0 ||
      result?.synced === 0 ||
      result?.skippedBeforePush?.length > 0 ||
      result?.skippedByManaPool?.length > 0;

    if (failed) {
      const message = JSON.stringify({ ...context, result });
      await InventoryItem.updateMany(
        { _id: { $in: ids } },
        { $set: { "manapool.lastSyncError": message } }
      );
    }

    return {
      ...result,
      ok: !failed,
      inventoryItemIds: ids,
      error: failed ? result?.error || "manapool_sync_incomplete" : null,
    };
  } catch (error) {
    const message = JSON.stringify({
      ...context,
      error: error?.response?.data || error?.message || String(error),
    });
    await InventoryItem.updateMany(
      { _id: { $in: ids } },
      { $set: { "manapool.lastSyncError": message } }
    );

    return {
      ok: false,
      inventoryItemIds: ids,
      error: error?.message || String(error),
    };
  }
}

router.post("/reconcile-order/:orderId", async (req, res, next) => {
  if (supportsTransactions()) return next();

  const orderId = String(req.params.orderId || "");

  try {
    const client = ct();
    const { data: order = {} } = await client.get(`/orders/${orderId}`);
    const orderCode = order?.code ? String(order.code) : null;
    const items = rawItems(order);

    const result = {
      ok: true,
      mode: "standalone_mongo_automatic",
      orderId,
      orderCode,
      totalLines: items.length,
      allocated: 0,
      retriedManualReview: 0,
      matchedByFallback: 0,
      skippedExisting: 0,
      manualReview: 0,
      failed: 0,
      failures: [],
      manaPoolSyncs: [],
    };

    for (const item of items) {
      const orderItemId = orderItemIdOf(item);
      const cardTraderId = cardTraderIdOf(item);
      const quantity = quantityOf(item);
      const name = nameOf(item);
      const lineKey = `${orderId}:${orderItemId}`;

      if (
        !Number.isFinite(orderItemId) ||
        !Number.isFinite(cardTraderId) ||
        quantity <= 0
      ) {
        result.failed += 1;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          reason: "invalid_order_line",
        });
        continue;
      }

      if (activeLines.has(lineKey)) {
        result.skippedExisting += 1;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          reason: "allocation_already_in_progress",
        });
        continue;
      }

      activeLines.add(lineKey);
      const lockName = `AutoAllocationLock:${crypto.randomUUID()}`;
      let allocation = null;
      let allocationBeforeLock = null;
      let wasRetry = false;
      const appliedSnapshots = [];

      try {
        const baseReview = reviewPayload({
          orderId,
          orderCode,
          orderItemId,
          cardTraderId,
          quantity,
          item,
          reason: "automatic_allocation_pending",
        });

        const ensured = await ensureReviewRecord(baseReview);
        allocation = ensured.allocation;
        wasRetry = !ensured.created;

        if (isStaleAutoLock(allocation)) {
          await OrderAllocation.updateOne(
            { _id: allocation._id, pickedBy: allocation.pickedBy },
            { $set: { picked: false, pickedAt: null, pickedBy: null } }
          );
          allocation = await OrderAllocation.findById(allocation._id);
        }

        if (!isRetryableManualReview(allocation)) {
          result.skippedExisting += 1;
          continue;
        }

        allocationBeforeLock = allocationSnapshot(allocation);

        const claimed = await OrderAllocation.findOneAndUpdate(
          {
            _id: allocation._id,
            status: "manual_review",
            $or: [
              { fulfilledQuantity: 0 },
              { fulfilledQuantity: null },
              { fulfilledQuantity: { $exists: false } },
            ],
            $and: [
              {
                $or: [
                  { pickedLocations: { $size: 0 } },
                  { pickedLocations: null },
                  { pickedLocations: { $exists: false } },
                ],
              },
              { picked: { $ne: true } },
            ],
          },
          {
            $set: {
              picked: true,
              pickedAt: new Date(),
              pickedBy: lockName,
              failureReason: "automatic_allocation_in_progress",
            },
          },
          { new: true }
        );

        if (!claimed) {
          result.skippedExisting += 1;
          result.failures.push({
            orderItemId,
            cardTraderId,
            name,
            reason: "allocation_line_changed_or_locked",
          });
          continue;
        }

        const inventoryItems = await InventoryItem.find({ cardTraderId })
          .populate("locations.bin", "name label rows description")
          .sort({ updatedAt: 1 });

        const plan = buildPlan(inventoryItems, quantity);

        if (
          plan.fulfilledQuantity < quantity ||
          plan.pickedLocations.length === 0
        ) {
          await OrderAllocation.updateOne(
            { _id: claimed._id, pickedBy: lockName },
            {
              $set: {
                ...baseReview,
                failureReason:
                  inventoryItems.length === 0
                    ? "exact_cardtrader_id_not_found"
                    : "not_enough_exact_stock_to_fully_allocate_line",
              },
            }
          );

          result.manualReview += 1;
          result.failures.push({
            orderItemId,
            cardTraderId,
            name,
            requestedQuantity: quantity,
            availableQuantity: inventoryItems.reduce(
              (sum, inventoryItem) => sum + assignedQuantity(inventoryItem),
              0
            ),
            reason:
              inventoryItems.length === 0
                ? "manual_review_exact_cardtrader_id_not_found"
                : "manual_review_not_enough_exact_stock",
          });
          continue;
        }

        const updatedInventoryItems = [];

        for (const step of plan.steps) {
          const snapshot = {
            id: step.item._id,
            version: Number(step.item.__v || 0),
            locations: (step.item.locations || []).map(locationData),
            totalQuantity: Number(step.item.totalQuantity || 0),
          };

          const newTotalQuantity = Math.max(
            0,
            snapshot.totalQuantity - step.pickedQuantity
          );

          const updateResult = await InventoryItem.updateOne(
            { _id: snapshot.id, __v: snapshot.version },
            {
              $set: {
                locations: step.remainingLocations,
                totalQuantity: newTotalQuantity,
              },
              $inc: { __v: 1 },
            }
          );

          if (Number(updateResult.modifiedCount || updateResult.nModified || 0) !== 1) {
            throw new Error("inventory_changed_during_automatic_allocation");
          }

          appliedSnapshots.push(snapshot);
          updatedInventoryItems.push({
            inventoryItemId: snapshot.id.toString(),
            cardTraderId,
            deductedQuantity: step.pickedQuantity,
            newQuantity: newTotalQuantity,
          });
        }

        const primaryInventoryItemId = plan.steps[0].item._id;
        const finalized = await OrderAllocation.findOneAndUpdate(
          {
            _id: claimed._id,
            status: "manual_review",
            pickedBy: lockName,
          },
          {
            $set: {
              source: "cardtrader",
              inventoryItemId: primaryInventoryItemId,
              orderId,
              orderCode,
              orderItemId,
              cardTraderId,
              requestedQuantity: quantity,
              fulfilledQuantity: quantity,
              unfilled: 0,
              name,
              condition: conditionOf(item),
              isFoil: foilOf(item),
              pickedLocations: plan.pickedLocations,
              picked: false,
              pickedAt: null,
              pickedBy: null,
              status: "allocated",
              failureReason: null,
              allocationMethod: "automatic",
              manualInventoryItemIds: [],
              manuallyAssignedAt: null,
              manuallyAssignedBy: null,
            },
          },
          { new: true }
        );

        if (!finalized) {
          throw new Error("allocation_finalize_conflict");
        }

        result.allocated += 1;
        if (wasRetry) result.retriedManualReview += 1;

        const inventoryItemIds = updatedInventoryItems.map(
          (updated) => updated.inventoryItemId
        );
        const manaPoolSync = await syncManaPool(inventoryItemIds, {
          source: "cardtrader_sale_automatic_allocation",
          orderId,
          orderItemId,
          cardTraderId,
          quantity,
        });

        if (manaPoolSync) {
          result.manaPoolSyncs.push({
            orderItemId,
            cardTraderId,
            ...manaPoolSync,
          });
        }

        console.log("✅ [ALLOCATIONS] AUTOMATIC ORDER LINE ALLOCATED", {
          mode: "standalone_mongo_automatic",
          orderId,
          orderCode,
          orderItemId,
          cardTraderId,
          name,
          quantity,
          inventoryItems: updatedInventoryItems,
          pickedLocations: plan.pickedLocations,
          manaPoolOk: manaPoolSync?.ok ?? null,
        });
      } catch (error) {
        const rollbackFailures = appliedSnapshots.length
          ? await restoreInventory(appliedSnapshots)
          : [];

        if (allocation?._id && allocationBeforeLock) {
          try {
            await restoreAllocation(allocation._id, allocationBeforeLock);
          } catch (restoreError) {
            rollbackFailures.push(`allocation:${allocation._id.toString()}`);
            console.error("❌ Failed to restore allocation after auto-allocation error", {
              orderId,
              orderItemId,
              allocationId: allocation._id.toString(),
              error: restoreError?.message || String(restoreError),
            });
          }
        }

        result.failed += 1;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          reason: "automatic_allocation_failed",
          details: error?.message || String(error),
          rollbackFailures,
        });

        console.error("❌ [ALLOCATIONS] Standalone automatic allocation failed", {
          orderId,
          orderCode,
          orderItemId,
          cardTraderId,
          name,
          error: error?.message || String(error),
          rollbackFailures,
        });
      } finally {
        activeLines.delete(lineKey);
      }
    }

    return res.json(result);
  } catch (error) {
    console.error("❌ Standalone reconcile-order failed", {
      orderId,
      error: error?.response?.data || error?.message || String(error),
    });

    return res.status(error?.response?.status || 500).json({
      ok: false,
      error: "standalone_reconcile_order_failed",
      details: error?.response?.data || error?.message || String(error),
    });
  }
});

export default router;
