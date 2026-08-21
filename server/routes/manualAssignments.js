import express from "express";
import { recordCompletedOperation } from "../services/operationRuns.js";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();
const EXPANSIONS_TTL_MS = 60 * 60 * 1000;
let expansionCache = { at: 0, codeByName: new Map() };

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value) {
  return clean(value).toLowerCase();
}

function normalizeCondition(value) {
  const normalized = normalizeText(value);
  if (["m", "mint"].includes(normalized)) return "mint";
  if (["nm", "near mint"].includes(normalized)) return "near mint";
  if (["lp", "sp", "lightly played", "slightly played"].includes(normalized)) {
    return "slightly played";
  }
  if (["mp", "moderately played"].includes(normalized)) return "moderately played";
  if (["hp", "heavily played"].includes(normalized)) return "heavily played";
  if (["p", "played"].includes(normalized)) return "played";
  return normalized;
}

function escapeRegex(value) {
  return clean(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactRegex(value) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

function finite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rawOrderItems(order) {
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
    item?.line_id
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
    item?.product?.id,
    item?.product?.product_id
  );
}

function blueprintIdOf(item) {
  return finite(
    item?.blueprint_id,
    item?.blueprintId,
    item?.product?.blueprint_id,
    item?.product?.blueprintId,
    item?.article?.blueprint_id,
    item?.blueprint?.id
  );
}

function setNameOf(item) {
  return (
    clean(
      item?.expansion?.name ||
        item?.expansion ||
        item?.set_name ||
        item?.setName ||
        item?.product?.set_name ||
        item?.product?.setName ||
        item?.product?.expansion?.name ||
        item?.product?.expansion
    ) || null
  );
}

function directSetCodeOf(item) {
  return (
    clean(
      item?.set_code ||
        item?.setCode ||
        item?.expansion_code ||
        item?.expansionCode ||
        item?.product?.set_code ||
        item?.product?.setCode ||
        item?.product?.expansion_code
    ) || null
  );
}

function assignedQuantity(item) {
  return (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) => sum + Math.max(0, Number(location?.quantity || 0)),
    0
  );
}

function sourceFilter() {
  return { $or: [{ source: "cardtrader" }, { source: { $exists: false } }] };
}

function isEmptyManualReview(allocation) {
  return (
    allocation?.status === "manual_review" &&
    Number(allocation?.fulfilledQuantity || 0) === 0 &&
    (!Array.isArray(allocation?.pickedLocations) || allocation.pickedLocations.length === 0)
  );
}

async function getExpansionCodeByName(setName) {
  const normalizedName = normalizeText(setName);
  if (!normalizedName) return null;

  const now = Date.now();
  if (!expansionCache.codeByName.size || now - expansionCache.at > EXPANSIONS_TTL_MS) {
    const { data } = await ct().get("/expansions");
    const expansions = Array.isArray(data)
      ? data
      : Array.isArray(data?.expansions)
        ? data.expansions
        : [];
    const codeByName = new Map();

    for (const expansion of expansions) {
      const code = clean(expansion?.code);
      if (!code) continue;
      for (const possibleName of [
        expansion?.name,
        expansion?.display_name,
        expansion?.displayName,
      ]) {
        const normalized = normalizeText(possibleName);
        if (normalized) codeByName.set(normalized, code);
      }
    }

    expansionCache = { at: now, codeByName };
  }

  return expansionCache.codeByName.get(normalizedName) || null;
}

async function getOrderLineContext(allocation) {
  try {
    const { data: order = {} } = await ct().get(`/orders/${allocation.orderId}`);
    const items = rawOrderItems(order);
    const line =
      items.find((item) => orderItemIdOf(item) === Number(allocation.orderItemId)) ||
      items.find(
        (item) =>
          Number.isFinite(Number(allocation.cardTraderId)) &&
          cardTraderIdOf(item) === Number(allocation.cardTraderId)
      ) ||
      null;

    const setName = line ? setNameOf(line) : null;
    const setCode = line ? directSetCodeOf(line) || (await getExpansionCodeByName(setName)) : null;

    return {
      orderCode: clean(order?.code || allocation.orderCode) || null,
      setName,
      setCode,
      blueprintId: line ? blueprintIdOf(line) : null,
      cardTraderId: line ? cardTraderIdOf(line) : allocation.cardTraderId,
    };
  } catch (error) {
    return {
      orderCode: allocation.orderCode || null,
      setName: null,
      setCode: null,
      blueprintId: null,
      cardTraderId: allocation.cardTraderId,
      contextError: error?.response?.data || error?.message || String(error),
    };
  }
}

function candidateEligibility(item, allocation, context) {
  const reasons = [];
  if (normalizeText(item?.name) !== normalizeText(allocation?.name)) {
    reasons.push("card name does not match");
  }
  if (
    normalizeCondition(item?.condition) !==
    normalizeCondition(allocation?.condition)
  ) {
    reasons.push("condition does not match");
  }
  if ((item?.isFoil === true) !== (allocation?.isFoil === true)) {
    reasons.push("foil finish does not match");
  }

  const expectedBlueprintId = Number(context?.blueprintId);
  if (Number.isFinite(expectedBlueprintId) && expectedBlueprintId > 0) {
    if (Number(item?.blueprintId) !== expectedBlueprintId) {
      reasons.push("printing/blueprint does not match");
    }
  } else if (context?.setCode) {
    if (normalizeCode(item?.setCode) !== normalizeCode(context.setCode)) {
      reasons.push("set does not match");
    }
  }

  if (assignedQuantity(item) <= 0) reasons.push("no assigned bin stock");
  return { eligible: reasons.length === 0, reasons };
}

function serializeCandidate(item, allocation, context) {
  const eligibility = candidateEligibility(item, allocation, context);
  return {
    inventoryItemId: item._id.toString(),
    cardTraderId: item.cardTraderId ?? null,
    blueprintId: item.blueprintId ?? null,
    name: item.name || null,
    setCode: item.setCode || null,
    condition: item.condition || null,
    isFoil: item.isFoil === true,
    totalQuantity: Number(item.totalQuantity || 0),
    assignedQuantity: assignedQuantity(item),
    locations: (Array.isArray(item.locations) ? item.locations : []).map((location) => ({
      bin:
        location?.bin && typeof location.bin === "object"
          ? location.bin.label || location.bin.name || location.bin._id?.toString?.()
          : location?.bin?.toString?.() || null,
      row: Number(location?.row || 0) || null,
      quantity: Number(location?.quantity || 0),
    })),
    eligible: eligibility.eligible,
    ineligibleReasons: eligibility.reasons,
  };
}

function buildAllocationPlan(items, requestedQuantity) {
  let remaining = Number(requestedQuantity || 0);
  const plans = [];
  const pickedLocations = [];

  const sorted = [...items].sort((a, b) => assignedQuantity(b) - assignedQuantity(a));
  for (const inventoryItem of sorted) {
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

async function syncOneInventoryItem(inventoryItemId, context) {
  const item = await InventoryItem.findById(inventoryItemId);
  if (!item) return { ok: false, error: "inventory_item_missing_after_commit" };

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

router.get("/", async (_req, res) => {
  try {
    const docs = await OrderAllocation.find({
      $and: [
        sourceFilter(),
        { status: "manual_review" },
        { fulfilledQuantity: 0 },
        { $or: [{ pickedLocations: { $size: 0 } }, { pickedLocations: { $exists: false } }] },
      ],
    })
      .sort({ updatedAt: -1 })
      .lean();

    const grouped = new Map();
    for (const doc of docs) {
      const key = `${doc.orderId}:${doc.orderItemId}`;
      const current = grouped.get(key);
      const preferred = current?.source === "cardtrader" ? current : doc;
      grouped.set(key, {
        ...preferred,
        duplicateCount: Number(current?.duplicateCount || 0) + 1,
      });
    }

    return res.json(
      [...grouped.values()].map((doc) => ({
        allocationId: doc._id.toString(),
        orderId: doc.orderId,
        orderCode: doc.orderCode || null,
        orderItemId: doc.orderItemId,
        cardTraderId: doc.cardTraderId ?? null,
        name: doc.name || "Unknown item",
        condition: doc.condition || null,
        isFoil: doc.isFoil === true,
        requestedQuantity: Number(doc.requestedQuantity || 0),
        failureReason: doc.failureReason || null,
        duplicateCount: doc.duplicateCount || 1,
        updatedAt: doc.updatedAt || null,
      }))
    );
  } catch (error) {
    return res.status(500).json({
      error: "failed_to_load_manual_assignments",
      details: error?.message || String(error),
    });
  }
});

router.get("/:allocationId/candidates", async (req, res) => {
  try {
    const allocation = await OrderAllocation.findById(req.params.allocationId).lean();
    if (!allocation || !isEmptyManualReview(allocation)) {
      return res.status(404).json({ error: "retryable_manual_review_not_found" });
    }

    const context = await getOrderLineContext(allocation);
    const items = await InventoryItem.find({ name: exactRegex(allocation.name) })
      .populate("locations.bin", "name label rows description")
      .lean();

    const candidates = items
      .map((item) => serializeCandidate(item, allocation, context))
      .sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        return b.assignedQuantity - a.assignedQuantity;
      });

    return res.json({
      allocation: {
        allocationId: allocation._id.toString(),
        orderId: allocation.orderId,
        orderCode: context.orderCode || allocation.orderCode || null,
        orderItemId: allocation.orderItemId,
        cardTraderId: allocation.cardTraderId ?? null,
        name: allocation.name || "Unknown item",
        condition: allocation.condition || null,
        isFoil: allocation.isFoil === true,
        requestedQuantity: Number(allocation.requestedQuantity || 0),
      },
      orderContext: context,
      candidates,
    });
  } catch (error) {
    return res.status(500).json({
      error: "failed_to_load_manual_assignment_candidates",
      details: error?.response?.data || error?.message || String(error),
    });
  }
});

router.post("/:allocationId/assign", async (req, res) => {
  const startedAt = new Date();
  const inventoryItemIds = [
    ...new Set(
      (Array.isArray(req.body?.inventoryItemIds) ? req.body.inventoryItemIds : [])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const manuallyAssignedBy = clean(req.body?.manuallyAssignedBy) || "Manual Assignments UI";

  if (!inventoryItemIds.length) {
    return res.status(400).json({ error: "inventoryItemIds_required" });
  }

  const session = await mongoose.startSession();
  let outcome = null;

  try {
    await session.withTransaction(async () => {
      const requestedAllocation = await OrderAllocation.findById(req.params.allocationId).session(
        session
      );
      if (!requestedAllocation) throw new Error("manual_review_not_found");

      const siblingAllocations = await OrderAllocation.find({
        orderId: String(requestedAllocation.orderId),
        orderItemId: Number(requestedAllocation.orderItemId),
        ...sourceFilter(),
      }).session(session);

      const alreadyAllocated = siblingAllocations.find(
        (allocation) =>
          allocation.status === "allocated" &&
          Number(allocation.fulfilledQuantity || 0) > 0 &&
          Array.isArray(allocation.pickedLocations) &&
          allocation.pickedLocations.length > 0
      );
      if (alreadyAllocated) {
        outcome = { type: "already_allocated", allocationId: alreadyAllocated._id.toString() };
        return;
      }

      const canonical =
        siblingAllocations.find((allocation) => allocation.source === "cardtrader") ||
        siblingAllocations.find(isEmptyManualReview) ||
        requestedAllocation;

      if (!isEmptyManualReview(canonical)) {
        throw new Error("allocation_is_not_retryable_manual_review");
      }

      const context = await getOrderLineContext(canonical);
      const inventoryItems = await InventoryItem.find({ _id: { $in: inventoryItemIds } })
        .populate("locations.bin", "name label rows description")
        .session(session);

      if (inventoryItems.length !== inventoryItemIds.length) {
        throw new Error("one_or_more_inventory_items_not_found");
      }

      const ineligible = inventoryItems
        .map((item) => ({ item, eligibility: candidateEligibility(item, canonical, context) }))
        .filter((entry) => !entry.eligibility.eligible);
      if (ineligible.length) {
        outcome = {
          type: "invalid_selection",
          details: ineligible.map(({ item, eligibility }) => ({
            inventoryItemId: item._id.toString(),
            reasons: eligibility.reasons,
          })),
        };
        return;
      }

      const requestedQuantity = Number(canonical.requestedQuantity || 0);
      const plan = buildAllocationPlan(inventoryItems, requestedQuantity);
      if (plan.fulfilledQuantity < requestedQuantity || !plan.pickedLocations.length) {
        outcome = {
          type: "insufficient_stock",
          requestedQuantity,
          availableQuantity: inventoryItems.reduce(
            (sum, item) => sum + assignedQuantity(item),
            0
          ),
        };
        return;
      }

      const updatedInventoryItems = [];
      for (const step of plan.plans) {
        const item = step.inventoryItem;
        item.locations = step.remainingLocations;
        item.totalQuantity = Math.max(
          0,
          Number(item.totalQuantity || 0) - step.pickedQuantity
        );
        item.markModified("locations");
        await item.save({ session });
        updatedInventoryItems.push({
          inventoryItemId: item._id.toString(),
          deductedQuantity: step.pickedQuantity,
          newQuantity: item.totalQuantity,
        });
      }

      canonical.source = "cardtrader";
      canonical.inventoryItemId = plan.plans[0].inventoryItem._id;
      canonical.fulfilledQuantity = requestedQuantity;
      canonical.unfilled = 0;
      canonical.pickedLocations = plan.pickedLocations;
      canonical.status = "allocated";
      canonical.failureReason = null;
      canonical.picked = false;
      canonical.pickedAt = null;
      canonical.pickedBy = null;
      canonical.allocationMethod = "manual_card_list";
      canonical.manualInventoryItemIds = inventoryItems.map((item) => item._id);
      canonical.manuallyAssignedAt = new Date();
      canonical.manuallyAssignedBy = manuallyAssignedBy;
      await canonical.save({ session });

      const staleSiblingIds = siblingAllocations
        .filter(
          (allocation) =>
            allocation._id.toString() !== canonical._id.toString() &&
            isEmptyManualReview(allocation)
        )
        .map((allocation) => allocation._id);
      if (staleSiblingIds.length) {
        await OrderAllocation.deleteMany({ _id: { $in: staleSiblingIds } }).session(session);
      }

      outcome = {
        type: "allocated",
        allocationId: canonical._id.toString(),
        orderId: canonical.orderId,
        orderItemId: canonical.orderItemId,
        cardTraderId: canonical.cardTraderId,
        requestedQuantity,
        pickedLocations: plan.pickedLocations,
        updatedInventoryItems,
        deletedStaleManualReviews: staleSiblingIds.length,
      };
    });

    if (outcome?.type === "already_allocated") {
      return res.json({ ok: true, alreadyAllocated: true, ...outcome });
    }
    if (outcome?.type === "invalid_selection") {
      return res.status(409).json({ error: "selected_inventory_does_not_match_order", ...outcome });
    }
    if (outcome?.type === "insufficient_stock") {
      return res.status(409).json({ error: "selected_inventory_has_insufficient_stock", ...outcome });
    }
    if (outcome?.type !== "allocated") {
      return res.status(409).json({ error: "manual_assignment_not_completed" });
    }

    const manaPoolSyncs = [];
    for (const updated of outcome.updatedInventoryItems) {
      const result = await syncOneInventoryItem(updated.inventoryItemId, {
        source: "manual_card_list_assignment",
        orderId: outcome.orderId,
        orderItemId: outcome.orderItemId,
        cardTraderId: outcome.cardTraderId,
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

    await recordCompletedOperation({
      kind: "manual-assignment",
      label: "Resolved an unassigned order line",
      source: "inventory",
      trigger: "manual",
      initiatedBy: manuallyAssignedBy,
      startedAt,
      status: manaPoolSyncs.some((sync) => !sync.ok)
        ? "completed_with_errors"
        : "completed",
      summary: {
        allocationId: outcome.allocationId,
        orderId: outcome.orderId,
        requestedQuantity: outcome.requestedQuantity,
        inventoryItemsUpdated: outcome.updatedInventoryItems.length,
      },
      errors: manaPoolSyncs.filter((sync) => !sync.ok),
    });

    return res.json({ ok: true, ...outcome, manaPoolSyncs });
  } catch (error) {
    return res.status(500).json({
      error: "manual_assignment_failed",
      details: error?.message || String(error),
    });
  } finally {
    await session.endSession();
  }
});

export default router;
