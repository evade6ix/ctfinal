import express from "express";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();

const rawItems = (order) =>
  Array.isArray(order?.order_items)
    ? order.order_items
    : Array.isArray(order?.items)
      ? order.items
      : Array.isArray(order?.order_items?.data)
        ? order.order_items.data
        : Array.isArray(order?.items?.data)
          ? order.items.data
          : [];

const finite = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const orderItemIdOf = (item) =>
  finite(item?.id, item?.order_item_id, item?.orderItemId, item?.line_id);

const cardTraderIdOf = (item) =>
  finite(
    item?.product_id,
    item?.productId,
    item?.cardTraderId,
    item?.card_trader_id,
    item?.article?.product_id,
    item?.product?.id
  );

const quantityOf = (item) => finite(item?.quantity, item?.qty, item?.amount) || 0;

const conditionOf = (item) =>
  item?.condition ||
  item?.card_condition ||
  item?.attributes?.condition ||
  item?.properties?.condition ||
  item?.properties_hash?.condition ||
  item?.properties_hash?.card_condition ||
  null;

const foilOf = (item) =>
  item?.isFoil === true ||
  item?.is_foil === true ||
  item?.foil === true ||
  item?.properties?.mtg_foil === true ||
  item?.properties_hash?.mtg_foil === true ||
  String(item?.variant || "").toLowerCase().includes("foil") ||
  String(item?.description || "").toLowerCase().includes("foil");

const assignedQuantity = (item) =>
  (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
    0
  );

const allocationFilter = (orderId, orderItemId) => ({
  orderId: String(orderId),
  orderItemId: Number(orderItemId),
  $or: [{ source: "cardtrader" }, { source: { $exists: false } }],
});

const retryableManualReview = (allocation) =>
  allocation?.status === "manual_review" &&
  Number(allocation?.fulfilledQuantity || 0) === 0 &&
  (!Array.isArray(allocation?.pickedLocations) ||
    allocation.pickedLocations.length === 0) &&
  allocation?.picked !== true;

function reviewPayload({ orderId, orderCode, orderItemId, cardTraderId, qty, item, reason }) {
  return {
    source: "cardtrader",
    inventoryItemId: null,
    orderId: String(orderId),
    orderCode,
    orderItemId,
    cardTraderId,
    requestedQuantity: qty,
    fulfilledQuantity: 0,
    unfilled: qty,
    name: item?.name || item?.product?.name || "Unknown item",
    condition: conditionOf(item),
    isFoil: foilOf(item),
    pickedLocations: [],
    picked: false,
    pickedAt: null,
    pickedBy: null,
    status: "manual_review",
    failureReason: reason,
  };
}

async function syncManaPool(inventoryItemId, context) {
  const inventoryItem = await InventoryItem.findById(inventoryItemId);
  if (!inventoryItem) return { ok: false, error: "inventory_item_missing_after_commit" };

  try {
    const result = await syncInventoryItemsToManaPool(inventoryItem, { livePush: true });
    const failed =
      !result?.ok ||
      result?.payloadCount === 0 ||
      result?.synced === 0 ||
      result?.skippedBeforePush?.length > 0 ||
      result?.skippedByManaPool?.length > 0;

    if (failed) {
      inventoryItem.manapool = inventoryItem.manapool || {};
      inventoryItem.manapool.lastSyncError = JSON.stringify({ ...context, result });
      await inventoryItem.save();
    }

    return result;
  } catch (error) {
    inventoryItem.manapool = inventoryItem.manapool || {};
    inventoryItem.manapool.lastSyncError = JSON.stringify({
      ...context,
      error: error?.response?.data || error?.message || String(error),
    });
    await inventoryItem.save();
    return { ok: false, error: error?.message || String(error) };
  }
}

// Mounted before the legacy orderAllocations router. This safely retries an
// existing empty manual_review allocation instead of permanently skipping it.
router.post("/reconcile-order/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const { data: order = {} } = await ct().get(`/orders/${orderId}`);
    const orderCode = order.code ? String(order.code) : null;
    const items = rawItems(order);

    const result = {
      ok: true,
      orderId,
      orderCode,
      totalLines: items.length,
      allocated: 0,
      retriedManualReview: 0,
      skippedExisting: 0,
      manualReview: 0,
      failed: 0,
      failures: [],
      manaPoolSyncs: [],
    };

    for (const item of items) {
      const orderItemId = orderItemIdOf(item);
      const cardTraderId = cardTraderIdOf(item);
      const qty = quantityOf(item);
      const name = item?.name || item?.product?.name || "Unknown item";

      if (!Number.isFinite(orderItemId) || !Number.isFinite(cardTraderId) || qty <= 0) {
        result.failed++;
        result.failures.push({ orderItemId, cardTraderId, name, reason: "invalid_order_line" });
        continue;
      }

      const session = await mongoose.startSession();
      let outcome = null;

      try {
        await session.withTransaction(async () => {
          const existing = await OrderAllocation.findOne(
            allocationFilter(orderId, orderItemId)
          ).session(session);

          if (existing && !retryableManualReview(existing)) {
            outcome = { type: "skipped" };
            return;
          }

          const candidates = await InventoryItem.find({ cardTraderId })
            .populate("locations.bin", "name label rows description")
            .session(session);

          candidates.sort((a, b) => assignedQuantity(b) - assignedQuantity(a));
          const inventoryItem =
            candidates.find((candidate) => assignedQuantity(candidate) >= qty) || null;

          if (!inventoryItem) {
            const payload = reviewPayload({
              orderId,
              orderCode,
              orderItemId,
              cardTraderId,
              qty,
              item,
              reason: "exact_cardtrader_id_not_found_or_no_stock",
            });
            if (existing) {
              existing.set(payload);
              await existing.save({ session });
            } else {
              await OrderAllocation.create([payload], { session });
            }
            outcome = { type: "review", reason: payload.failureReason };
            return;
          }

          const allocation = allocateFromBins(inventoryItem.locations || [], qty);
          const fulfilled = allocation.pickedLocations.reduce(
            (sum, location) => sum + Number(location?.quantity || 0),
            0
          );

          if (fulfilled < qty || !allocation.pickedLocations.length) {
            const payload = reviewPayload({
              orderId,
              orderCode,
              orderItemId,
              cardTraderId,
              qty,
              item,
              reason: "not_enough_exact_stock_to_fully_allocate_line",
            });
            if (existing) {
              existing.set(payload);
              await existing.save({ session });
            } else {
              await OrderAllocation.create([payload], { session });
            }
            outcome = { type: "review", reason: payload.failureReason, fulfilled };
            return;
          }

          inventoryItem.locations = allocation.remainingLocations;
          inventoryItem.totalQuantity = Math.max(
            0,
            Number(inventoryItem.totalQuantity || 0) - fulfilled
          );
          inventoryItem.markModified("locations");
          await inventoryItem.save({ session });

          const payload = {
            source: "cardtrader",
            inventoryItemId: inventoryItem._id,
            orderId,
            orderCode,
            orderItemId,
            cardTraderId,
            requestedQuantity: qty,
            fulfilledQuantity: fulfilled,
            unfilled: allocation.unfilled,
            name: name || inventoryItem.name || "Unknown item",
            condition: conditionOf(item) || inventoryItem.condition || null,
            isFoil: foilOf(item) || inventoryItem.isFoil === true,
            pickedLocations: allocation.pickedLocations.map((location) => ({
              bin: location?.bin?._id || location?.bin,
              row: location?.row,
              quantity: location?.quantity,
            })),
            picked: false,
            pickedAt: null,
            pickedBy: null,
            status: "allocated",
            failureReason: null,
          };

          if (existing) {
            existing.set(payload);
            await existing.save({ session });
          } else {
            await OrderAllocation.create([payload], { session });
          }

          outcome = {
            type: "allocated",
            retried: !!existing,
            inventoryItemId: inventoryItem._id.toString(),
            newQuantity: inventoryItem.totalQuantity,
          };
        });
      } catch (error) {
        result.failed++;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          reason: "allocation_transaction_failed",
          details: error?.message || String(error),
        });
      } finally {
        await session.endSession();
      }

      if (outcome?.type === "skipped") {
        result.skippedExisting++;
      } else if (outcome?.type === "review") {
        result.manualReview++;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          requestedQuantity: qty,
          fulfilled: outcome.fulfilled || 0,
          reason: `manual_review_${outcome.reason}`,
        });
      } else if (outcome?.type === "allocated") {
        result.allocated++;
        if (outcome.retried) result.retriedManualReview++;

        const syncResult = await syncManaPool(outcome.inventoryItemId, {
          source: "cardtrader_sale_allocation",
          orderId,
          orderItemId,
          cardTraderId,
          newQuantity: outcome.newQuantity,
        });

        result.manaPoolSyncs.push({
          orderItemId,
          cardTraderId,
          inventoryItemId: outcome.inventoryItemId,
          ok: syncResult?.ok === true,
          synced: syncResult?.synced || 0,
          error: syncResult?.error || null,
        });
      }
    }

    return res.json(result);
  } catch (error) {
    console.error("❌ safe CardTrader reconcile-order failed:", error);
    return res.status(500).json({
      ok: false,
      error: "reconcile_order_failed",
      details: error?.response?.data || error?.message || String(error),
    });
  }
});

export default router;
