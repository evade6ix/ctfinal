import express from "express";
import mongoose from "mongoose";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();

const EXPANSIONS_TTL_MS = 60 * 60 * 1000;
let expansionsCache = {
  fetchedAt: 0,
  codeByName: new Map(),
};

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
  finite(
    item?.id,
    item?.order_item_id,
    item?.orderItemId,
    item?.seller_order_item_id,
    item?.line_id
  );

const cardTraderIdOf = (item) =>
  finite(
    item?.product_id,
    item?.productId,
    item?.cardTraderId,
    item?.card_trader_id,
    item?.seller_product_id,
    item?.article?.product_id,
    item?.product?.id,
    item?.product?.product_id
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

const quantityOf = (item) =>
  finite(item?.quantity, item?.qty, item?.amount) || 0;

const nameOf = (item) =>
  String(item?.name || item?.product?.name || "Unknown item").trim();

const setNameOf = (item) =>
  String(
    item?.expansion?.name ||
      item?.expansion ||
      item?.set_name ||
      item?.setName ||
      item?.product?.set_name ||
      item?.product?.setName ||
      item?.product?.expansion?.name ||
      item?.product?.expansion ||
      ""
  ).trim() || null;

const directSetCodeOf = (item) =>
  String(
    item?.set_code ||
      item?.setCode ||
      item?.expansion_code ||
      item?.expansionCode ||
      item?.product?.set_code ||
      item?.product?.setCode ||
      item?.product?.expansion_code ||
      ""
  ).trim() || null;

const conditionOf = (item) =>
  item?.condition ||
  item?.card_condition ||
  item?.attributes?.condition ||
  item?.properties?.condition ||
  item?.properties_hash?.condition ||
  item?.properties_hash?.card_condition ||
  null;

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCondition(value) {
  const normalized = normalizeText(value);

  if (["m", "mint"].includes(normalized)) return "mint";
  if (["nm", "near mint"].includes(normalized)) return "near mint";
  if (
    ["lp", "sp", "lightly played", "slightly played"].includes(normalized)
  ) {
    return "slightly played";
  }
  if (["mp", "moderately played"].includes(normalized)) {
    return "moderately played";
  }
  if (["hp", "heavily played"].includes(normalized)) {
    return "heavily played";
  }
  if (["p", "played"].includes(normalized)) return "played";
  if (normalized === "poor") return "poor";

  return normalized;
}

function truthyFoil(value) {
  if (value === true || value === 1) return true;

  const normalized = String(value || "").trim().toLowerCase();
  if (
    !normalized ||
    /(?:^|[\s_-])non[\s_-]*foil(?:$|[\s_-])/.test(` ${normalized} `) ||
    normalized.includes("nonfoil") ||
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

const foilOf = (item) => {
  const explicit = explicitFoilOf(item);
  if (explicit !== null) return explicit;

  return (
    textSaysFoil(item?.variant) ||
    textSaysFoil(item?.description)
  );
};

const assignedQuantity = (item) =>
  (Array.isArray(item?.locations) ? item.locations : []).reduce(
    (sum, location) =>
      sum + Math.max(0, Number(location?.quantity || 0)),
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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactRegex(value) {
  return new RegExp(`^${escapeRegex(String(value || "").trim())}$`, "i");
}

async function getExpansionCodeByName(client, setName) {
  const normalizedSetName = normalizeText(setName);
  if (!normalizedSetName) return null;

  const now = Date.now();
  if (
    expansionsCache.codeByName.size === 0 ||
    now - expansionsCache.fetchedAt > EXPANSIONS_TTL_MS
  ) {
    try {
      const { data } = await client.get("/expansions");
      const expansions = Array.isArray(data)
        ? data
        : Array.isArray(data?.expansions)
          ? data.expansions
          : [];

      const codeByName = new Map();
      for (const expansion of expansions) {
        const code = String(expansion?.code || "").trim();
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

      expansionsCache = {
        fetchedAt: now,
        codeByName,
      };
    } catch (error) {
      console.warn("⚠️ [ALLOCATIONS] Could not refresh CardTrader expansions", {
        error: error?.response?.data || error?.message || String(error),
      });
    }
  }

  return expansionsCache.codeByName.get(normalizedSetName) || null;
}

async function resolveSetCode(client, item) {
  const directCode = directSetCodeOf(item);
  if (directCode) return directCode;

  const setName = setNameOf(item);
  if (!setName) return null;

  return getExpansionCodeByName(client, setName);
}

function reviewPayload({
  orderId,
  orderCode,
  orderItemId,
  cardTraderId,
  qty,
  item,
  reason,
}) {
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
    name: nameOf(item),
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
    locations: (Array.isArray(item?.locations) ? item.locations : []).map(
      (location) => ({
        bin:
          location?.bin && typeof location.bin === "object"
            ? location.bin.label ||
              location.bin.name ||
              location.bin._id?.toString?.()
            : location?.bin?.toString?.() || null,
        row: Number(location?.row || 0) || null,
        quantity: Number(location?.quantity || 0),
      })
    ),
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

    const allocation = allocateFromBins(
      inventoryItem.locations || [],
      remaining
    );
    const pickedQuantity = allocation.pickedLocations.reduce(
      (sum, location) =>
        sum + Math.max(0, Number(location?.quantity || 0)),
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
    fulfilledQuantity: Math.max(
      0,
      Number(requestedQuantity || 0) - remaining
    ),
    unfilled: Math.max(0, remaining),
  };
}

function filterVariantCandidates(
  candidates,
  { condition, isFoil, excludedIds = new Set() }
) {
  const wantedCondition = normalizeCondition(condition);

  return candidates.filter((candidate) => {
    const id = candidate?._id?.toString?.();
    if (id && excludedIds.has(id)) return false;
    if (assignedQuantity(candidate) <= 0) return false;
    if ((candidate?.isFoil === true) !== isFoil) return false;

    return (
      !wantedCondition ||
      normalizeCondition(candidate?.condition) === wantedCondition
    );
  });
}

async function loadInventoryCandidates({
  cardTraderId,
  blueprintId,
  name,
  setCode,
  condition,
  isFoil,
  requestedQuantity,
  session,
}) {
  const exactCandidates = await InventoryItem.find({ cardTraderId })
    .populate("locations.bin", "name label rows description")
    .session(session);

  const selected = [...exactCandidates];
  const selectedIds = new Set(
    selected.map((candidate) => candidate._id.toString())
  );
  const exactAssigned = totalAssignedQuantity(exactCandidates);

  let blueprintCandidates = [];
  let nameSetCandidates = [];
  let uniqueNameCandidates = [];
  let matchStrategy = "exact_cardtrader_id";

  if (
    totalAssignedQuantity(selected) < requestedQuantity &&
    Number.isFinite(blueprintId) &&
    blueprintId > 0
  ) {
    const possibleBlueprintCandidates = await InventoryItem.find({
      blueprintId,
    })
      .populate("locations.bin", "name label rows description")
      .session(session);

    blueprintCandidates = filterVariantCandidates(
      possibleBlueprintCandidates,
      {
        condition,
        isFoil,
        excludedIds: selectedIds,
      }
    );

    for (const candidate of blueprintCandidates) {
      selected.push(candidate);
      selectedIds.add(candidate._id.toString());
    }

    if (blueprintCandidates.length > 0) {
      matchStrategy =
        exactAssigned > 0
          ? "exact_plus_blueprint_fallback"
          : "blueprint_fallback";
    }
  }

  if (
    totalAssignedQuantity(selected) < requestedQuantity &&
    name &&
    setCode
  ) {
    const possibleNameSetCandidates = await InventoryItem.find({
      name: exactRegex(name),
      setCode: exactRegex(setCode),
    })
      .populate("locations.bin", "name label rows description")
      .session(session);

    nameSetCandidates = filterVariantCandidates(
      possibleNameSetCandidates,
      {
        condition,
        isFoil,
        excludedIds: selectedIds,
      }
    );

    for (const candidate of nameSetCandidates) {
      selected.push(candidate);
      selectedIds.add(candidate._id.toString());
    }

    if (nameSetCandidates.length > 0) {
      matchStrategy =
        selected.length > nameSetCandidates.length
          ? "exact_or_blueprint_plus_name_set_fallback"
          : "name_set_fallback";
    }
  }

  // Last safe fallback: exact card name + condition + foil, but only when
  // every stocked candidate belongs to one distinct printing/set and no
  // partial exact match would be mixed with another printing.
  if (
    totalAssignedQuantity(selected) < requestedQuantity &&
    totalAssignedQuantity(selected) === 0 &&
    name
  ) {
    const possibleNameCandidates = await InventoryItem.find({
      name: exactRegex(name),
    })
      .populate("locations.bin", "name label rows description")
      .session(session);

    const filtered = filterVariantCandidates(possibleNameCandidates, {
      condition,
      isFoil,
      excludedIds: selectedIds,
    });

    const printingKeys = new Set(
      filtered.map((candidate) => {
        const bp = Number(candidate?.blueprintId);
        if (Number.isFinite(bp) && bp > 0) return `bp:${bp}`;

        const code = normalizeCode(candidate?.setCode);
        return code ? `set:${code}` : `item:${candidate._id.toString()}`;
      })
    );

    if (printingKeys.size === 1) {
      uniqueNameCandidates = filtered;

      for (const candidate of uniqueNameCandidates) {
        selected.push(candidate);
        selectedIds.add(candidate._id.toString());
      }

      if (uniqueNameCandidates.length > 0) {
        matchStrategy =
          selected.length > uniqueNameCandidates.length
            ? "existing_plus_unique_name_fallback"
            : "unique_name_fallback";
      }
    }
  }

  return {
    candidates: selected,
    exactCandidates,
    blueprintCandidates,
    nameSetCandidates,
    uniqueNameCandidates,
    exactAssigned,
    combinedAssigned: totalAssignedQuantity(selected),
    matchStrategy,
  };
}

async function syncManaPool(inventoryItemId, context) {
  const inventoryItem = await InventoryItem.findById(inventoryItemId);
  if (!inventoryItem) {
    return {
      ok: false,
      error: "inventory_item_missing_after_commit",
    };
  }

  try {
    const result = await syncInventoryItemsToManaPool(inventoryItem, {
      livePush: true,
    });
    const failed =
      !result?.ok ||
      result?.payloadCount === 0 ||
      result?.synced === 0 ||
      result?.skippedBeforePush?.length > 0 ||
      result?.skippedByManaPool?.length > 0;

    if (failed) {
      inventoryItem.manapool = inventoryItem.manapool || {};
      inventoryItem.manapool.lastSyncError = JSON.stringify({
        ...context,
        result,
      });
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
      error:
        error?.response?.data ||
        error?.message ||
        String(error),
    });
    await inventoryItem.save();

    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

// Safely retries existing empty manual_review allocations. Allocated records
// are always skipped, so a sale cannot be deducted twice.
router.post("/reconcile-order/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const client = ct();
    const { data: order = {} } = await client.get(`/orders/${orderId}`);
    const orderCode = order.code ? String(order.code) : null;
    const items = rawItems(order);

    const result = {
      ok: true,
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
      const blueprintId = blueprintIdOf(item);
      const qty = quantityOf(item);
      const name = nameOf(item);
      const setName = setNameOf(item);
      const resolvedSetCode = await resolveSetCode(client, item);
      const condition = conditionOf(item);
      const isFoil = foilOf(item);

      if (
        !Number.isFinite(orderItemId) ||
        !Number.isFinite(cardTraderId) ||
        qty <= 0
      ) {
        result.failed++;
        result.failures.push({
          orderItemId,
          cardTraderId,
          name,
          reason: "invalid_order_line",
        });
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
            name,
            setCode: resolvedSetCode,
            condition,
            isFoil,
            requestedQuantity: qty,
            session,
          });

          const allocation = buildAllocationPlan(
            inventorySearch.candidates,
            qty
          );

          if (
            allocation.fulfilledQuantity < qty ||
            !allocation.pickedLocations.length
          ) {
            const reason =
              inventorySearch.candidates.length === 0
                ? "matching_inventory_not_found"
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
              setName,
              resolvedSetCode,
              exactAssigned: inventorySearch.exactAssigned,
              combinedAssigned: inventorySearch.combinedAssigned,
              matchStrategy: inventorySearch.matchStrategy,
              exactCandidates: inventorySearch.exactCandidates
                .slice(0, 10)
                .map(candidateSummary),
              blueprintCandidates: inventorySearch.blueprintCandidates
                .slice(0, 10)
                .map(candidateSummary),
              nameSetCandidates: inventorySearch.nameSetCandidates
                .slice(0, 10)
                .map(candidateSummary),
              uniqueNameCandidates: inventorySearch.uniqueNameCandidates
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
              Number(inventoryItem.totalQuantity || 0) -
                plan.pickedQuantity
            );
            inventoryItem.markModified("locations");
            await inventoryItem.save({ session });

            updatedInventoryItems.push({
              inventoryItemId: inventoryItem._id.toString(),
              newQuantity: inventoryItem.totalQuantity,
              deductedQuantity: plan.pickedQuantity,
            });
          }

          const primaryInventoryItem =
            allocation.plans[0].inventoryItem;
          const payload = {
            source: "cardtrader",
            inventoryItemId: primaryInventoryItem._id,
            orderId,
            orderCode,
            orderItemId,
            cardTraderId,
            requestedQuantity: qty,
            fulfilledQuantity: allocation.fulfilledQuantity,
            unfilled: allocation.unfilled,
            name: name || primaryInventoryItem.name || "Unknown item",
            condition:
              condition || primaryInventoryItem.condition || null,
            isFoil:
              isFoil || primaryInventoryItem.isFoil === true,
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
            setName,
            resolvedSetCode,
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
          setName,
          resolvedSetCode,
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
          setName,
          resolvedSetCode,
          requestedQuantity: qty,
          condition,
          isFoil,
          fulfilled: outcome.fulfilled || 0,
          exactAssigned: outcome.exactAssigned || 0,
          combinedAssigned: outcome.combinedAssigned || 0,
          matchStrategy: outcome.matchStrategy,
          reason: `manual_review_${outcome.reason}`,
          exactCandidates: outcome.exactCandidates,
          blueprintCandidates: outcome.blueprintCandidates,
          nameSetCandidates: outcome.nameSetCandidates,
          uniqueNameCandidates: outcome.uniqueNameCandidates,
        };
        result.failures.push(failure);

        console.warn(
          "⚠️ [ALLOCATIONS] MANUAL REVIEW STILL HAS NO BINS",
          {
            orderId,
            orderCode,
            ...failure,
          }
        );
      } else if (outcome?.type === "allocated") {
        result.allocated++;
        if (outcome.retried) result.retriedManualReview++;
        if (outcome.matchStrategy !== "exact_cardtrader_id") {
          result.matchedByFallback++;
        }

        console.log("✅ [ALLOCATIONS] ORDER LINE ALLOCATED", {
          orderId,
          orderCode,
          orderItemId,
          cardTraderId,
          blueprintId,
          name,
          setName,
          resolvedSetCode,
          quantity: qty,
          condition,
          isFoil,
          matchStrategy: outcome.matchStrategy,
          inventoryItems: outcome.updatedInventoryItems,
          pickedLocations: outcome.pickedLocations,
        });

        for (const updated of outcome.updatedInventoryItems) {
          const syncResult = await syncManaPool(
            updated.inventoryItemId,
            {
              source: "cardtrader_sale_allocation",
              orderId,
              orderItemId,
              cardTraderId,
              blueprintId,
              setName,
              resolvedSetCode,
              matchStrategy: outcome.matchStrategy,
              newQuantity: updated.newQuantity,
              deductedQuantity: updated.deductedQuantity,
            }
          );

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
    console.error(
      "❌ safe CardTrader reconcile-order failed:",
      error
    );
    return res.status(500).json({
      ok: false,
      error: "reconcile_order_failed",
      details:
        error?.response?.data ||
        error?.message ||
        String(error),
    });
  }
});

export default router;
