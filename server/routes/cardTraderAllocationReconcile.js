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

const blueprintIdOf = (item) =>
  finite(
    item?.blueprint_id,
    item?.blueprintId,
    item?.product?.blueprint_id,
    item?.product?.blueprintId,
    item?.article?.blueprint_id,
    item?.article?.blueprintId,
    item?.blueprint?.id
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

function normalizeCondition(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (["m", "mint"].includes(normalized)) return "mint";
  if (["nm", "near mint"].includes(normalized)) return "near mint";
  if (["lp", "sp", "lightly played", "slightly played"].includes(normalized)) {
    return "slightly played";
  }
  if (["mp", "moderately played"].includes(normalized)) return "moderately played";
  if (["hp", "heavily played"].includes(normalized)) return "heavily played";
  if (["p", "played"].includes(normalized)) return "played";
  if (normalized === "poor") return "poor";

  return normalized;
}

function truthyFoil(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "1", "yes", "foil", "foiled"].includes(normalized);
}

const foilOf = (item) =>
  truthyFoil(item?.isFoil) ||
  truthyFoil(item?.is_foil) ||
  truthyFoil(item?.foil) ||
  truthyFoil(item?.properties?.mtg_foil) ||
  truthyFoil(item?.properties_hash?.mtg_foil) ||
  String(item?.variant || "").toLowerCase().includes("foil") ||
  String(item?.description || "").toLowerCase().includes("foil");

const assignedQuantity = (item) =>
  (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
    0
  );

const totalAssignedQuantity = (items) =>
  (Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + assignedQuantity(item),
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

function candidateSummary(item) {
  return {
    inventoryItemId: item?._id?.toString?.() || null,
    cardTraderId: item?.cardTraderId ?? null,
    blueprintId: item?.blueprintId ?? null,
    name: item?.name || null,
    setCode: item?.setCode || null,
    condition: item?.condition || null,
    isFoil: item?.isFoil === true,
    totalQuantity: Number(item?.totalQuantity || 0),
    assignedQuantity: assignedQuantity(item),
    locations: (Array.isArray(item?.locations) ? item.locations : []).map((location) => ({
      bin:
        location?.bin && typeof location.bin === "object"
          ? location.bin.label || location.bin.name || location.bin._id?.toString?.()
          : location?.bin?.toString?.() || null,
      row: Number(location?.row || 0) || null,
      quantity: Number(location?.quantity || 0),
    })),
  };
}

function buildAllocationPlan(candidates, requestedQuantity) {
  let remaining = Number(requestedQuantity) || 0;
  const plans = [];
  const pickedLocations = [];

  const sortedCandidates = [...candidates].sort(
    (a, b) => assignedQuantity(b) - assignedQuantity(a)
  );

  for (const inventoryItem of sortedCandidates) {
    if (remaining <= 0) break;

    const allocation = allocateFromBins(inventoryItem.locations || [], remaining);
    const pickedQuantity = allocation.pickedLocations.reduce(
      (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
      0
    );

    if (pickedQuantity <= 0) continue;

    plans.push({
      inventoryItem,
      pickedQuantity,
      remainingLocations: allocation.remainingLocations,
    });

    pickedLocations.push(
      ...allocation.pickedLocations.map((location) => ({
        bin: location?.bin?._id || location?.bin,
        row: location?.row,
        quantity: location?.quantity,
      }))
    );

    remaining -= pickedQuantity;
  }

  return {
    plans,
    pickedLocations,
    fulfilledQuantity: Math.max(0, Number(requestedQuantity || 0) - remaining),
    unfilled: Math.max(0, remaining),
  };
}

async function loadInventoryCandidates({
  cardTraderId,
  blueprintId,
  condition,
  isFoil,
  requestedQuantity,
  session,
}) {
  const exactCandidates = await InventoryItem.find({ cardTraderId })
    .populate("locations.bin", "name label rows description")
    .session(session);

  const exactIds = new Set(exactCandidates.map((candidate) => candidate._id.toString()));
  const exactAssigned = totalAssignedQuantity(exactCandidates);
  let blueprintCandidates = [];

  if (
    exactAssigned < requestedQuantity &&
    Number.isFinite(blueprintId) &&
    blueprintId > 0 &&
    normalizeCondition(condition)
  ) {
    const possibleBlueprintCandidates = await InventoryItem.find({ blueprintId })
      .populate("locations.bin", "name label rows description")
      .session(session);

    const wantedCondition = normalizeCondition(condition);

    blueprintCandidates = possibleBlueprintCandidates.filter((candidate) => {
      if (exactIds.has(candidate._id.toString())) return false;
      if ((candidate.isFoil === true) !== isFoil) return false;
      return normalizeCondition(candidate.condition) === wantedCondition;
    });
  }

  const candidates = [...exactCandidates, ...blueprintCandidates];
  const combinedAssigned = totalAssignedQuantity(candidates);

  let matchStrategy = "exact_cardtrader_id";
  if (exactAssigned < requestedQuantity && blueprintCandidates.length > 0) {
    matchStrategy =
      exactAssigned > 0 ? "exact_plus_blueprint_fallback" : "blueprint_fallback";
  }

  return {
    candidates,
    exactCandidates,
    blueprintCandidates,
    exactAssigned,
    combinedAssigned,
    matchStrategy,
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
      return {
        ...result,
        ok: false,
        error: result?.error || "manapool_sync_incomplete",
      };
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
      matchedByBlueprint: 0,
      skippedExisting: 0,
      manualReview: 0,
      failed: 0,
      failures: [],
      manaPoolSyncs: [],
    };

    for (const item of items) {
      const orderItemId = orderItemIdOf(item);
      const cardTraderId = cardTraderIdOf(item);
      const blueprintId = blueprintIdOf(item);
      const qty = quantityOf(item);
      const name = item?.name || item?.product?.name || "Unknown item";
      const condition = conditionOf(item);
      const isFoil = foilOf(item);

      if (!Number.isFinite(orderItemId) || !Number.isFinite(cardTraderId) || qty <= 0) {
        result.failed++;
        result.failures.push({ orderItemId, cardTraderId, name, reason: "invalid_order_line" });
        continue;
      }

      const session = await mongoose.startSession();
      let outcome = null;

      try {
        await session.withTransaction(async () => {
          outcome = null;

          const existing = await OrderAllocation.findOne(
            allocationFilter(orderId, orderItemId)
          ).session(session);

          if (existing && !retryableManualReview(existing)) {
            outcome = { type: "skipped" };
            return;
          }

          const inventorySearch = await loadInventoryCandidates({
            cardTraderId,
            blueprintId,
            condition,
            isFoil,
            requestedQuantity: qty,
            session,
          });

          const allocation = buildAllocationPlan(inventorySearch.candidates, qty);

          if (
            allocation.fulfilledQuantity < qty ||
            !allocation.pickedLocations.length
          ) {
            const reason =
              inventorySearch.candidates.length === 0
                ? "exact_or_blueprint_inventory_not_found"
                : "not_enough_matching_stock_to_fully_allocate_line";

            const payload = reviewPayload({
              orderId,
              orderCode,
              orderItemId,
              cardTraderId,
              qty,
              item,
              reason,
            });

            if (existing) {
              existing.set(payload);
              await existing.save({ session });
            } else {
              await OrderAllocation.create([payload], { session });
            }

            outcome = {
              type: "review",
              reason,
              fulfilled: allocation.fulfilledQuantity,
              blueprintId,
              exactAssigned: inventorySearch.exactAssigned,
              combinedAssigned: inventorySearch.combinedAssigned,
              exactCandidates: inventorySearch.exactCandidates
                .slice(0, 10)
                .map(candidateSummary),
              blueprintCandidates: inventorySearch.blueprintCandidates
                .slice(0, 10)
                .map(candidateSummary),
            };
            return;
          }

          const updatedInventoryItems = [];

          for (const plan of allocation.plans) {
            const inventoryItem = plan.inventoryItem;
            inventoryItem.locations = plan.remainingLocations;
            inventoryItem.totalQuantity = Math.max(
              0,
              Number(inventoryItem.totalQuantity || 0) - plan.pickedQuantity
            );
            inventoryItem.markModified("locations");
            await inventoryItem.save({ session });

            updatedInventoryItems.push({
              inventoryItemId: inventoryItem._id.toString(),
              newQuantity: inventoryItem.totalQuantity,
              deductedQuantity: plan.pickedQuantity,
            });
          }

          const payload = {
            source: "cardtrader",
            inventoryItemId: allocation.plans[0].inventoryItem._id,
            orderId,
            orderCode,
            orderItemId,
            cardTraderId,
            requestedQuantity: qty,
            fulfilledQuantity: allocation.fulfilledQuantity,
            unfilled: allocation.unfilled,
            name: name || allocation.plans[0].inventoryItem.name || "Unknown item",
            condition: condition || allocation.plans[0].inventoryItem.condition || null,
            isFoil: isFoil || allocation.plans[0].inventoryItem.isFoil === true,
            pickedLocations: allocation.pickedLocations,
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
            matchStrategy: inventorySearch.matchStrategy,
            blueprintId,
            updatedInventoryItems,
            pickedLocations: allocation.pickedLocations,
          };
        });
      } catch (error) {
        outcome = null;
        result.failed++;
        result.failures.push({
          orderItemId,
          cardTraderId,
          blueprintId,
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
        const failure = {
          orderItemId,
          cardTraderId,
          blueprintId,
          name,
          requestedQuantity: qty,
          fulfilled: outcome.fulfilled || 0,
          exactAssigned: outcome.exactAssigned || 0,
          combinedAssigned: outcome.combinedAssigned || 0,
          reason: `manual_review_${outcome.reason}`,
          exactCandidates: outcome.exactCandidates,
          blueprintCandidates: outcome.blueprintCandidates,
        };
        result.failures.push(failure);

        console.warn("⚠️ [ALLOCATIONS] MANUAL REVIEW STILL HAS NO BINS", {
          orderId,
          orderCode,
          ...failure,
        });
      } else if (outcome?.type === "allocated") {
        result.allocated++;
        if (outcome.retried) result.retriedManualReview++;
        if (outcome.matchStrategy !== "exact_cardtrader_id") {
          result.matchedByBlueprint++;
        }

        console.log("✅ [ALLOCATIONS] ORDER LINE ALLOCATED", {
          orderId,
          orderCode,
          orderItemId,
          cardTraderId,
          blueprintId,
          name,
          quantity: qty,
          matchStrategy: outcome.matchStrategy,
          inventoryItems: outcome.updatedInventoryItems,
          pickedLocations: outcome.pickedLocations,
        });

        for (const updated of outcome.updatedInventoryItems) {
          const syncResult = await syncManaPool(updated.inventoryItemId, {
            source: "cardtrader_sale_allocation",
            orderId,
            orderItemId,
            cardTraderId,
            blueprintId,
            matchStrategy: outcome.matchStrategy,
            newQuantity: updated.newQuantity,
            deductedQuantity: updated.deductedQuantity,
          });

          result.manaPoolSyncs.push({
            orderItemId,
            cardTraderId,
            blueprintId,
            inventoryItemId: updated.inventoryItemId,
            ok: syncResult?.ok === true,
            synced: syncResult?.synced || 0,
            error: syncResult?.error || null,
          });
        }
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
