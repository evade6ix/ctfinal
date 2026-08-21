import express from "express";
import { recordCompletedOperation } from "../services/operationRuns.js";
import crypto from "crypto";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();
const activeAssignments = new Set();
const LOCK_TTL_MS = 10 * 60 * 1000;

function supportsTransactions() {
  const type = String(
    mongoose.connection?.client?.topology?.description?.type || ""
  );
  return type.includes("ReplicaSet") || type.includes("Sharded");
}

function sourceFilter() {
  return { $or: [{ source: "cardtrader" }, { source: { $exists: false } }] };
}

function isEmptyManualReview(allocation) {
  return (
    allocation?.status === "manual_review" &&
    Number(allocation?.fulfilledQuantity || 0) === 0 &&
    (!Array.isArray(allocation?.pickedLocations) ||
      allocation.pickedLocations.length === 0)
  );
}

function assignedQuantity(item) {
  return (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
    0
  );
}

function locationSnapshot(item) {
  return (Array.isArray(item?.locations) ? item.locations : []).map((location) => ({
    bin: location?.bin?._id || location?.bin,
    row: Number(location?.row),
    quantity: Number(location?.quantity || 0),
  }));
}

function allocationSnapshot(allocation) {
  return {
    source: allocation.source || "cardtrader",
    inventoryItemId: allocation.inventoryItemId || null,
    fulfilledQuantity: Number(allocation.fulfilledQuantity || 0),
    unfilled: Number(allocation.unfilled || 0),
    pickedLocations: Array.isArray(allocation.pickedLocations)
      ? allocation.pickedLocations.map((location) => ({
          bin: location?.bin?._id || location?.bin,
          row: Number(location?.row),
          quantity: Number(location?.quantity || 0),
        }))
      : [],
    status: allocation.status,
    failureReason: allocation.failureReason || null,
    picked: allocation.picked === true,
    pickedAt: allocation.pickedAt || null,
    pickedBy: allocation.pickedBy || null,
    allocationMethod: allocation.allocationMethod || "automatic",
    manualInventoryItemIds: allocation.manualInventoryItemIds || [],
    manuallyAssignedAt: allocation.manuallyAssignedAt || null,
    manuallyAssignedBy: allocation.manuallyAssignedBy || null,
  };
}

function buildPlan(items, requestedQuantity) {
  let remaining = Number(requestedQuantity || 0);
  const plans = [];
  const pickedLocations = [];

  for (const item of [...items].sort(
    (a, b) => assignedQuantity(b) - assignedQuantity(a)
  )) {
    if (remaining <= 0) break;
    const allocation = allocateFromBins(item.locations || [], remaining);
    const pickedQuantity = allocation.pickedLocations.reduce(
      (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
      0
    );
    if (pickedQuantity <= 0) continue;

    plans.push({
      item,
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
    fulfilledQuantity: Math.max(0, requestedQuantity - remaining),
  };
}

async function restoreAllocation(id, snapshot) {
  await OrderAllocation.updateOne(
    { _id: id },
    {
      $set: {
        source: snapshot.source,
        inventoryItemId: snapshot.inventoryItemId,
        fulfilledQuantity: snapshot.fulfilledQuantity,
        unfilled: snapshot.unfilled,
        pickedLocations: snapshot.pickedLocations,
        status: snapshot.status,
        failureReason: snapshot.failureReason,
        picked: snapshot.picked,
        pickedAt: snapshot.pickedAt,
        pickedBy: snapshot.pickedBy,
        allocationMethod: snapshot.allocationMethod,
        manualInventoryItemIds: snapshot.manualInventoryItemIds,
        manuallyAssignedAt: snapshot.manuallyAssignedAt,
        manuallyAssignedBy: snapshot.manuallyAssignedBy,
      },
    }
  );
}

async function restoreInventory(snapshots) {
  for (const snapshot of [...snapshots].reverse()) {
    await InventoryItem.updateOne(
      { _id: snapshot.id },
      {
        $set: {
          locations: snapshot.locations,
          totalQuantity: snapshot.totalQuantity,
        },
      }
    );
  }
}

async function loadEligibleCandidateIds(allocationId) {
  const port = process.env.PORT || 3000;
  const response = await fetch(
    `http://127.0.0.1:${port}/api/manual-assignments/${allocationId}/candidates`
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.details || body?.error || "candidate_validation_failed");
  }

  return new Set(
    (Array.isArray(body?.candidates) ? body.candidates : [])
      .filter((candidate) => candidate?.eligible === true)
      .map((candidate) => String(candidate.inventoryItemId))
  );
}

async function syncOne(itemId, context) {
  const item = await InventoryItem.findById(itemId);
  if (!item) return { ok: false, error: "inventory_item_missing_after_assignment" };

  try {
    const result = await syncInventoryItemsToManaPool(item, { livePush: true });
    const failed =
      !result?.ok ||
      result?.payloadCount === 0 ||
      result?.synced === 0 ||
      result?.skippedBeforePush?.length > 0 ||
      result?.skippedByManaPool?.length > 0;

    if (failed) {
      item.manapool = item.manapool || {};
      item.manapool.lastSyncError = JSON.stringify({ ...context, result });
      await item.save();
      return { ...result, ok: false, error: result?.error || "manapool_sync_incomplete" };
    }
    return result;
  } catch (error) {
    item.manapool = item.manapool || {};
    item.manapool.lastSyncError = JSON.stringify({
      ...context,
      error: error?.response?.data || error?.message || String(error),
    });
    await item.save();
    return { ok: false, error: error?.message || String(error) };
  }
}

router.post("/:allocationId/assign", async (req, res, next) => {
  if (supportsTransactions()) return next();

  const startedAt = new Date();

  const allocationId = String(req.params.allocationId || "");
  const inventoryItemIds = [
    ...new Set(
      (Array.isArray(req.body?.inventoryItemIds) ? req.body.inventoryItemIds : [])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const manuallyAssignedBy =
    String(req.body?.manuallyAssignedBy || "").trim() || "Manual Assignments UI";

  if (!inventoryItemIds.length) return next();
  if (activeAssignments.has(allocationId)) {
    return res.status(409).json({
      error: "manual_assignment_already_in_progress",
      details: "This order line is already being assigned.",
    });
  }

  activeAssignments.add(allocationId);
  const lockName = `ManualAssignmentLock:${crypto.randomUUID()}`;
  let snapshot = null;
  let inventoryChanged = false;
  let completed = false;
  const inventorySnapshots = [];

  try {
    let allocation = await OrderAllocation.findById(allocationId);
    if (!allocation) return next();

    const staleLock =
      allocation.status === "manual_review" &&
      allocation.picked === true &&
      String(allocation.pickedBy || "").startsWith("ManualAssignmentLock:") &&
      (!allocation.pickedAt ||
        Date.now() - new Date(allocation.pickedAt).getTime() > LOCK_TTL_MS);

    if (staleLock) {
      await OrderAllocation.updateOne(
        { _id: allocationId, pickedBy: allocation.pickedBy },
        { $set: { picked: false, pickedAt: null, pickedBy: null } }
      );
      allocation = await OrderAllocation.findById(allocationId);
    }

    snapshot = allocationSnapshot(allocation);

    const claimed = await OrderAllocation.findOneAndUpdate(
      {
        _id: allocationId,
        status: "manual_review",
        fulfilledQuantity: 0,
        picked: { $ne: true },
        $or: [
          { pickedLocations: { $size: 0 } },
          { pickedLocations: { $exists: false } },
        ],
      },
      { $set: { picked: true, pickedAt: new Date(), pickedBy: lockName } },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({
        error: "manual_assignment_line_changed_or_locked",
        details: "Refresh the page; this line changed or is already being assigned.",
      });
    }

    const eligibleIds = await loadEligibleCandidateIds(allocationId);
    const invalidIds = inventoryItemIds.filter((id) => !eligibleIds.has(id));
    if (invalidIds.length) {
      await restoreAllocation(allocationId, snapshot);
      return res.status(409).json({
        error: "selected_inventory_does_not_match_order",
        invalidInventoryItemIds: invalidIds,
      });
    }

    const items = await InventoryItem.find({ _id: { $in: inventoryItemIds } }).populate(
      "locations.bin",
      "name label rows description"
    );
    if (items.length !== inventoryItemIds.length) {
      await restoreAllocation(allocationId, snapshot);
      return res.status(409).json({ error: "one_or_more_inventory_items_not_found" });
    }

    const requestedQuantity = Number(claimed.requestedQuantity || 0);
    const plan = buildPlan(items, requestedQuantity);
    if (plan.fulfilledQuantity < requestedQuantity || !plan.pickedLocations.length) {
      await restoreAllocation(allocationId, snapshot);
      return res.status(409).json({
        error: "selected_inventory_has_insufficient_stock",
        requestedQuantity,
        availableQuantity: items.reduce((sum, item) => sum + assignedQuantity(item), 0),
      });
    }

    const updatedItems = [];
    for (const step of plan.plans) {
      inventorySnapshots.push({
        id: step.item._id,
        locations: locationSnapshot(step.item),
        totalQuantity: Number(step.item.totalQuantity || 0),
      });

      step.item.locations = step.remainingLocations;
      step.item.totalQuantity = Math.max(
        0,
        Number(step.item.totalQuantity || 0) - step.pickedQuantity
      );
      step.item.markModified("locations");
      inventoryChanged = true;
      await step.item.save();

      updatedItems.push({
        inventoryItemId: step.item._id.toString(),
        deductedQuantity: step.pickedQuantity,
        newQuantity: step.item.totalQuantity,
      });
    }

    const finalized = await OrderAllocation.findOneAndUpdate(
      { _id: allocationId, status: "manual_review", pickedBy: lockName },
      {
        $set: {
          source: "cardtrader",
          inventoryItemId: plan.plans[0].item._id,
          fulfilledQuantity: requestedQuantity,
          unfilled: 0,
          pickedLocations: plan.pickedLocations,
          status: "allocated",
          failureReason: null,
          picked: false,
          pickedAt: null,
          pickedBy: null,
          allocationMethod: "manual_card_list",
          manualInventoryItemIds: items.map((item) => item._id),
          manuallyAssignedAt: new Date(),
          manuallyAssignedBy,
        },
      },
      { new: true }
    );
    if (!finalized) throw new Error("manual_assignment_finalize_conflict");

    completed = true;

    const siblings = await OrderAllocation.find({
      orderId: String(finalized.orderId),
      orderItemId: Number(finalized.orderItemId),
      ...sourceFilter(),
    });
    const staleIds = siblings
      .filter(
        (sibling) =>
          sibling._id.toString() !== finalized._id.toString() &&
          isEmptyManualReview(sibling)
      )
      .map((sibling) => sibling._id);

    let staleCleanupError = null;
    if (staleIds.length) {
      try {
        await OrderAllocation.deleteMany({ _id: { $in: staleIds } });
      } catch (error) {
        staleCleanupError = error?.message || String(error);
      }
    }

    const manaPoolSyncs = [];
    for (const updated of updatedItems) {
      const result = await syncOne(updated.inventoryItemId, {
        source: "manual_card_list_assignment_standalone_mongo",
        orderId: finalized.orderId,
        orderItemId: finalized.orderItemId,
        cardTraderId: finalized.cardTraderId,
        deductedQuantity: updated.deductedQuantity,
        newQuantity: updated.newQuantity,
        manuallyAssignedBy,
      });
      manaPoolSyncs.push({
        inventoryItemId: updated.inventoryItemId,
        ok: result?.ok === true,
        synced: result?.synced || 0,
        error: result?.error || null,
      });
    }

    const response = {
      ok: true,
      standaloneMongoFallback: true,
      allocationId: finalized._id.toString(),
      orderId: finalized.orderId,
      orderItemId: finalized.orderItemId,
      requestedQuantity,
      pickedLocations: plan.pickedLocations,
      updatedInventoryItems: updatedItems,
      deletedStaleManualReviews: staleCleanupError ? 0 : staleIds.length,
      staleCleanupError,
      manaPoolSyncs,
    };

    await recordCompletedOperation({
      kind: "manual-assignment",
      label: "Resolved an unassigned order line",
      source: "inventory",
      trigger: "manual",
      initiatedBy: manuallyAssignedBy,
      startedAt,
      status: manaPoolSyncs.some((sync) => !sync.ok) || staleCleanupError
        ? "completed_with_errors"
        : "completed",
      summary: {
        allocationId: finalized._id.toString(),
        orderId: finalized.orderId,
        requestedQuantity,
        inventoryItemsUpdated: updatedItems.length,
      },
      errors: manaPoolSyncs.filter((sync) => !sync.ok),
    });

    return res.json(response);
  } catch (error) {
    const rollbackErrors = [];
    if (!completed && inventoryChanged) {
      try {
        await restoreInventory(inventorySnapshots);
      } catch (rollbackError) {
        rollbackErrors.push(`inventory: ${rollbackError?.message || String(rollbackError)}`);
      }
    }
    if (!completed && snapshot) {
      try {
        await restoreAllocation(allocationId, snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(`allocation: ${rollbackError?.message || String(rollbackError)}`);
      }
    }

    console.error("❌ Standalone Mongo manual assignment failed", {
      allocationId,
      error: error?.message || String(error),
      rollbackErrors,
    });

    return res.status(500).json({
      error: "manual_assignment_failed",
      details: error?.message || String(error),
      rollbackErrors,
    });
  } finally {
    activeAssignments.delete(allocationId);
  }
});

export default router;
