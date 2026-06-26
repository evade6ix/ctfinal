// server/routes/orderAllocations.js
import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();

function extractCondition(it) {
  return (
    it.condition ||
    it.card_condition ||
    it.attributes?.condition ||
    it.properties?.condition ||
    it.properties_hash?.condition ||
    it.properties_hash?.card_condition ||
    null
  );
}

function extractIsFoil(it) {
  return (
    it.isFoil === true ||
    it.is_foil === true ||
    it.foil === true ||
    String(it.isFoil || "").toLowerCase() === "true" ||
    String(it.is_foil || "").toLowerCase() === "true" ||
    String(it.foil || "").toLowerCase() === "true" ||
    it.properties?.mtg_foil === true ||
    String(it.properties?.mtg_foil || "").toLowerCase() === "true" ||
    it.properties_hash?.mtg_foil === true ||
    String(it.properties_hash?.mtg_foil || "").toLowerCase() === "true" ||
    String(it.variant || "").toLowerCase().includes("foil") ||
    String(it.name || "").toLowerCase().includes("foil") ||
    String(it.description || "").toLowerCase().includes("foil")
  );
}

function buildAllocationFilter({ orderId, orderItemId, cardTraderId }) {
  if (!orderId) return null;

  if (typeof orderItemId !== "undefined" && orderItemId !== null) {
    return {
      orderId: String(orderId),
      orderItemId: Number(orderItemId),
    };
  }

  if (typeof cardTraderId !== "undefined" && cardTraderId !== null) {
    return {
      orderId: String(orderId),
      cardTraderId: Number(cardTraderId),
    };
  }

  return null;
}

router.get("/by-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const docs = await OrderAllocation.find({
      orderId: String(orderId),
    }).lean();

    return res.json(docs || []);
  } catch (err) {
    console.error("❌ Error in GET /api/order-allocations/by-order:", err);
    return res.status(500).json({ error: "Failed to load allocations for order" });
  }
});

router.patch("/pick", async (req, res) => {
  try {
    const { orderId, orderItemId, cardTraderId, pickedBy } = req.body || {};
    const filter = buildAllocationFilter({ orderId, orderItemId, cardTraderId });

    if (!filter) {
      return res.status(400).json({
        error: "orderId and either orderItemId or cardTraderId are required",
      });
    }

    const update = {
      picked: true,
      pickedAt: new Date(),
    };

    if (pickedBy && typeof pickedBy === "string") {
      update.pickedBy = pickedBy;
    }

    const doc = await OrderAllocation.findOneAndUpdate(filter, update, {
      new: true,
    });

    if (!doc) {
      return res.status(404).json({
        error: "Allocation not found for given order line",
        filter,
      });
    }

    return res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/pick:", err);
    return res.status(500).json({ error: "Failed to mark allocation as picked" });
  }
});

router.patch("/unpick", async (req, res) => {
  try {
    const { orderId, orderItemId, cardTraderId } = req.body || {};
    const filter = buildAllocationFilter({ orderId, orderItemId, cardTraderId });

    if (!filter) {
      return res.status(400).json({
        error: "orderId and either orderItemId or cardTraderId are required",
      });
    }

    const doc = await OrderAllocation.findOneAndUpdate(
      filter,
      {
        picked: false,
        pickedAt: null,
        pickedBy: null,
      },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({
        error: "Allocation not found for given order line",
        filter,
      });
    }

    return res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/unpick:", err);
    return res.status(500).json({ error: "Failed to clear picked state" });
  }
});

router.post("/cleanup-stale", async (req, res) => {
  return res.json({
    ok: true,
    disabled: true,
    message:
      "cleanup-stale is disabled because deleting allocations without restoring inventory is unsafe.",
    deletedAllocations: 0,
  });
});

/**
 * POST /api/order-allocations/reconcile-order/:orderId
 *
 * SAFE RULES:
 * - Exact CardTrader product_id only.
 * - No fallback by name / blueprint / condition.
 * - If exact inventory is missing, create manual_review allocation.
 * - If allocation already exists for orderId + orderItemId, skip.
 * - Inventory is deducted only once, when creating a brand-new allocated record.
 */
router.post("/reconcile-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderIdStr = String(orderId);

    const client = ct();
    const orderRes = await client.get(`/orders/${orderId}`);
    const order = orderRes.data || {};
    const orderCodeStr = order.code ? String(order.code) : null;

    let rawItems = [];
    if (Array.isArray(order.order_items)) rawItems = order.order_items;
    else if (Array.isArray(order.items)) rawItems = order.items;
    else if (order.order_items && Array.isArray(order.order_items.data)) {
      rawItems = order.order_items.data;
    } else if (order.items && Array.isArray(order.items.data)) {
      rawItems = order.items.data;
    }

    let allocated = 0;
    let skippedExisting = 0;
    let manualReview = 0;
    let failed = 0;
    const failures = [];

    for (const it of rawItems) {
      const orderItemId = Number(it.id);
      const cardTraderId = Number(it.product_id);
      const requestedQty = Number(it.quantity) || 0;
      const condition = extractCondition(it);
      const isFoil = extractIsFoil(it);

      if (!Number.isFinite(orderItemId) || !Number.isFinite(cardTraderId) || requestedQty <= 0) {
        failed++;
        failures.push({
          orderItemId: it.id ?? null,
          cardTraderId: it.product_id ?? null,
          name: it.name || "Unknown item",
          reason: "invalid_order_line",
        });
        continue;
      }

      const existing = await OrderAllocation.findOne({
        orderId: orderIdStr,
        orderItemId,
      }).lean();

      if (existing) {
        skippedExisting++;
        continue;
      }

      const invItem = await InventoryItem.findOne({ cardTraderId })
        .populate("locations.bin", "name label rows description")
        .exec();

      const hasUsableStock =
        invItem &&
        Array.isArray(invItem.locations) &&
        invItem.locations.reduce((sum, loc) => sum + Number(loc.quantity || 0), 0) > 0;

      if (!hasUsableStock) {
        await OrderAllocation.create({
          orderId: orderIdStr,
          orderCode: orderCodeStr,
          orderItemId,
          cardTraderId,
          requestedQuantity: requestedQty,
          fulfilledQuantity: 0,
          unfilled: requestedQty,
          name: it.name || "Unknown item",
          condition,
          isFoil,
          pickedLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
          status: "manual_review",
          failureReason: "exact_cardtrader_id_not_found_or_no_stock",
        });

        manualReview++;

        failures.push({
          orderItemId,
          cardTraderId,
          name: it.name || "Unknown item",
          reason: "manual_review_exact_cardtrader_id_not_found_or_no_stock",
        });

        continue;
      }

      const { pickedLocations, remainingLocations, unfilled } = allocateFromBins(
        invItem.locations || [],
        requestedQty
      );

      const totalPicked = pickedLocations.reduce(
        (sum, loc) => sum + Number(loc.quantity || 0),
        0
      );

      if (totalPicked < requestedQty || !pickedLocations.length) {
        await OrderAllocation.create({
          orderId: orderIdStr,
          orderCode: orderCodeStr,
          orderItemId,
          cardTraderId,
          requestedQuantity: requestedQty,
          fulfilledQuantity: 0,
          unfilled: requestedQty,
          name: it.name || "Unknown item",
          condition,
          isFoil,
          pickedLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
          status: "manual_review",
          failureReason: "not_enough_exact_stock_to_fully_allocate_line",
        });

        manualReview++;

        failures.push({
          orderItemId,
          cardTraderId,
          name: it.name || "Unknown item",
          requestedQty,
          totalPicked,
          reason: "manual_review_not_enough_exact_stock_to_fully_allocate_line",
        });

        continue;
      }

      invItem.locations = remainingLocations;
invItem.totalQuantity = Math.max(
  0,
  Number(invItem.totalQuantity || 0) - totalPicked
);

await invItem.save();

try {
  const manaPoolResult = await syncInventoryItemsToManaPool(invItem, {
    livePush: true,
  });

  console.log("✅ [ALLOCATIONS] ManaPool quantity synced after CardTrader sale", {
    orderId: orderIdStr,
    orderItemId,
    cardTraderId,
    inventoryItemId: invItem._id?.toString?.(),
    newQuantity: invItem.totalQuantity,
    ok: manaPoolResult?.ok,
    payloadCount: manaPoolResult?.payloadCount,
    synced: manaPoolResult?.synced,
    mongoUpdated: manaPoolResult?.mongoUpdated,
    skippedBeforePush: manaPoolResult?.skippedBeforePush,
    skippedByManaPool: manaPoolResult?.skippedByManaPool,
  });

  if (
    !manaPoolResult?.ok ||
    manaPoolResult?.payloadCount === 0 ||
    manaPoolResult?.synced === 0 ||
    manaPoolResult?.skippedBeforePush?.length > 0 ||
    manaPoolResult?.skippedByManaPool?.length > 0
  ) {
    invItem.manapool = invItem.manapool || {};
    invItem.manapool.lastSyncError = JSON.stringify({
      source: "cardtrader_sale_allocation",
      orderId: orderIdStr,
      orderItemId,
      cardTraderId,
      newQuantity: invItem.totalQuantity,
      result: manaPoolResult,
    });

    await invItem.save();
  }
} catch (manaPoolErr) {
  console.error("❌ [ALLOCATIONS] Failed to sync ManaPool after CardTrader sale", {
    orderId: orderIdStr,
    orderItemId,
    cardTraderId,
    inventoryItemId: invItem._id?.toString?.(),
    error: manaPoolErr?.response?.data || manaPoolErr?.message || manaPoolErr,
  });

  invItem.manapool = invItem.manapool || {};
  invItem.manapool.lastSyncError =
    typeof manaPoolErr?.response?.data === "string"
      ? manaPoolErr.response.data
      : JSON.stringify(
          manaPoolErr?.response?.data || manaPoolErr?.message || manaPoolErr
        );

  await invItem.save();
}

await OrderAllocation.create({
        orderId: orderIdStr,
        orderCode: orderCodeStr,
        orderItemId,
        cardTraderId,
        requestedQuantity: requestedQty,
        fulfilledQuantity: totalPicked,
        unfilled,
        name: it.name || invItem.name || "Unknown item",
        condition: condition || invItem.condition || null,
        isFoil: isFoil || invItem.isFoil === true,
        pickedLocations: pickedLocations.map((pl) => ({
          bin: pl.bin?._id || pl.bin,
          row: pl.row,
          quantity: pl.quantity,
        })),
        picked: false,
        pickedAt: null,
        pickedBy: null,
        status: "allocated",
        failureReason: null,
      });

      allocated++;
    }

    return res.json({
      ok: true,
      orderId: orderIdStr,
      orderCode: orderCodeStr,
      totalLines: rawItems.length,
      allocated,
      skippedExisting,
      manualReview,
      failed,
      failures,
    });
  } catch (err) {
    console.error("❌ reconcile-order failed:", err);
    return res.status(500).json({
      ok: false,
      error: "reconcile_order_failed",
      details: err?.message || String(err),
    });
  }
});

/**
 * Disabled for now because rebuilding can deduct inventory.
 */
router.post("/rebuild-order/:orderId", async (req, res) => {
  return res.status(410).json({
    ok: false,
    disabled: true,
    error: "rebuild_order_disabled",
    message:
      "Rebuild order is disabled because it can re-deduct inventory. Use reconcile-order only after confirming the order is safe/current.",
  });
});

export default router;