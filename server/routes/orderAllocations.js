// server/routes/orderAllocations.js
import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { ct } from "../ctClient.js";
const router = express.Router();

function normalizeCondition(condition = "") {
  const c = String(condition).trim().toLowerCase();

  if (c === "near mint" || c === "nm") return "NM";
  if (c === "lightly played" || c === "slightly played" || c === "lp" || c === "sp") return "LP";
  if (c === "moderately played" || c === "mp") return "MP";
  if (c === "heavily played" || c === "hp") return "HP";
  if (c === "damaged" || c === "poor" || c === "dm" || c === "dmg") return "DMG";

  return String(condition || "").trim();
}

function getConditionOptions(condition) {
  const normalized = normalizeCondition(condition);

  if (normalized === "NM") return ["NM", "Near Mint", "near mint", "nm"];
  if (normalized === "LP") return ["LP", "Lightly Played", "lightly played", "Slightly Played", "slightly played", "SP", "sp"];
  if (normalized === "MP") return ["MP", "Moderately Played", "moderately played"];
  if (normalized === "HP") return ["HP", "Heavily Played", "heavily played"];
  if (normalized === "DMG") return ["DMG", "Damaged", "damaged", "Poor", "poor"];

  return [normalized];
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * GET /api/order-allocations/by-order/:orderId
 * Returns all allocations for a given orderId.
 */
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

/**
 * PATCH /api/order-allocations/pick
 * Body: { orderId: string | number, orderItemId?: number, cardTraderId?: number, pickedBy?: string }
 */
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

/**
 * PATCH /api/order-allocations/unpick
 * Body: { orderId: string | number, orderItemId?: number, cardTraderId?: number }
 */
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

/**
 * POST /api/order-allocations/cleanup-stale
 */
router.post("/cleanup-stale", async (req, res) => {
  try {
    const client = ct();

    const paidOrderIds = new Set();
    let page = 1;
    const limit = 50;

    while (true) {
      const r = await client.get("/orders", {
        params: {
          order_as: "seller",
          sort: "date.desc",
          page,
          limit,
          state: "paid",
        },
      });

      const batch = Array.isArray(r.data) ? r.data : [];
      if (!batch.length) break;

      for (const o of batch) {
        if (o && typeof o.id !== "undefined") {
          paidOrderIds.add(String(o.id));
        }
      }

      if (batch.length < limit) break;
      page++;
    }

    const paidIdArray = Array.from(paidOrderIds);

    return res.json({
  ok: true,
  disabled: true,
  message:
    "cleanup-stale is disabled because it can delete HUB_PENDING weekly allocations. Re-enable only after it supports paid + hub_pending + orderCode.",
  paidOrdersSeen: paidIdArray.length,
  deletedAllocations: 0,
});
  } catch (err) {
    console.error("❌ Error in POST /api/order-allocations/cleanup-stale:", err);
    return res.status(500).json({
      error: "Failed to cleanup stale order allocations",
    });
  }
});

/**
 * POST /api/order-allocations/reconcile-order/:orderId
 * Server-side allocator only.
 * This is the ONLY route that should deduct inventory and create OrderAllocation records.
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
    else if (order.order_items && Array.isArray(order.order_items.data)) rawItems = order.order_items.data;
    else if (order.items && Array.isArray(order.items.data)) rawItems = order.items.data;

    let allocated = 0;
    let skippedExisting = 0;
    let failed = 0;
    const failures = [];

    for (const it of rawItems) {
      const orderItemId = Number(it.id);
      const cardTraderId = Number(it.product_id);
      const requestedQty = Number(it.quantity) || 0;

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

            let allocationClaim = null;

      try {
        allocationClaim = await OrderAllocation.create({
          orderId: orderIdStr,
          orderCode: orderCodeStr,
          orderItemId,
          cardTraderId,
          requestedQuantity: requestedQty,
          fulfilledQuantity: 0,
          unfilled: requestedQty,
          name: it.name || "Unknown item",
          condition:
            it.condition ||
            it.card_condition ||
            it.attributes?.condition ||
            it.properties?.condition ||
            it.properties_hash?.condition ||
            it.properties_hash?.card_condition ||
            null,
          isFoil:
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
            String(it.description || "").toLowerCase().includes("foil"),
          pickedLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
        });
      } catch (err) {
        if (err?.code === 11000) {
          skippedExisting++;
          continue;
        }

        failed++;
        failures.push({
          orderItemId,
          cardTraderId,
          name: it.name || "Unknown item",
          reason: "failed_to_claim_order_line",
          error: err?.message || String(err),
        });
        continue;
      }

            let invItem = await InventoryItem.findOne({ cardTraderId })
        .populate("locations.bin", "name label rows description")
        .exec();

      const hasUsableStock = (item) =>
        item &&
        Array.isArray(item.locations) &&
        item.locations.reduce((sum, loc) => sum + Number(loc.quantity || 0), 0) > 0;

      if (!hasUsableStock(invItem)) {
        const blueprintId = Number(it.blueprint_id);
        const condition =
          it.condition ||
          it.card_condition ||
          it.attributes?.condition ||
          it.properties?.condition ||
          it.properties_hash?.condition ||
          it.properties_hash?.card_condition ||
          null;

        const isFoil =
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
          String(it.description || "").toLowerCase().includes("foil");

        if (Number.isFinite(blueprintId)) {
          const escapedName = escapeRegex(it.name || "");
          const conditionOptions = getConditionOptions(condition);

          const fallbackItem = await InventoryItem.findOne({
            name: new RegExp(`^${escapedName}$`, "i"),
            blueprintId,
            condition: { $in: conditionOptions },
            isFoil,
            locations: { $exists: true, $ne: [] },
          })
            .populate("locations.bin", "name label rows description")
            .exec();

          if (hasUsableStock(fallbackItem)) {
            console.warn("⚠️ USING SAFE FALLBACK INVENTORY MATCH", {
              orderId: orderIdStr,
              orderCode: orderCodeStr,
              orderItemId,
              soldCardTraderId: cardTraderId,
              fallbackCardTraderId: fallbackItem.cardTraderId,
              name: it.name,
              blueprintId,
              condition,
              isFoil,
            });

            invItem = fallbackItem;
          }
        }
      }

      if (!hasUsableStock(invItem)) {
  await OrderAllocation.deleteOne({ _id: allocationClaim._id });

  failed++;
  failures.push({
    orderItemId,
    cardTraderId,
    name: it.name || "Unknown item",
    reason: "no_usable_stock_exact_or_safe_fallback",
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

if (totalPicked < requestedQty) {
  await OrderAllocation.deleteOne({ _id: allocationClaim._id });
  failed++;
  failures.push({
    orderItemId,
    cardTraderId,
    name: it.name || "Unknown item",
    requestedQty,
    totalPicked,
    reason: "not_enough_stock_to_fully_allocate_line",
  });
  continue;
}

      if (!pickedLocations.length) {
        await OrderAllocation.deleteOne({ _id: allocationClaim._id });
        failed++;
        failures.push({
          orderItemId,
          cardTraderId,
          name: it.name || "Unknown item",
          reason: "allocateFromBins_returned_empty",
        });
        continue;
      }

      const fulfilledQty = totalPicked;

      invItem.locations = remainingLocations;
      invItem.totalQuantity = Math.max(0, Number(invItem.totalQuantity || 0) - fulfilledQty);
      await invItem.save();

            await OrderAllocation.updateOne(
        { _id: allocationClaim._id },
        {
          $set: {
        orderId: orderIdStr,
        orderCode: orderCodeStr,
        orderItemId,
        cardTraderId,
        requestedQuantity: requestedQty,
        fulfilledQuantity: fulfilledQty,
        unfilled,
        name: it.name || invItem.name || "Unknown item",
        condition:
  it.condition ||
  it.card_condition ||
  it.attributes?.condition ||
  it.properties?.condition ||
  it.properties_hash?.condition ||
  it.properties_hash?.card_condition ||
  invItem.condition ||
  null,

isFoil:
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
  String(it.description || "").toLowerCase().includes("foil") ||
  invItem.isFoil === true,
        pickedLocations: pickedLocations.map((pl) => ({
          bin: pl.bin?._id || pl.bin,
          row: pl.row,
          quantity: pl.quantity,
        })),
        picked: false,
        pickedAt: null,
        pickedBy: null,
                },
        }
      );

      allocated++;
    }

    return res.json({
      ok: true,
      orderId: orderIdStr,
      orderCode: orderCodeStr,
      totalLines: rawItems.length,
      allocated,
      skippedExisting,
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
 * POST /api/order-allocations/rebuild-order/:orderId
 */
router.post("/rebuild-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const url = `http://localhost:${process.env.PORT || 3000}/api/order-allocations/reconcile-order/${orderId}`;
console.log(
  `🔁 [ORDER-ALLOCATIONS] Rebuilding allocations for order ${orderId} via ${url}`
);

const resp = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
});
    const raw = await resp.text().catch(() => "");

    if (!resp.ok) {
      console.error(
        "❌ Failed to rebuild order allocations",
        orderId,
        resp.status,
        raw.slice(0, 500)
      );

      return res.status(500).json({
        ok: false,
        error: "Failed to rebuild order allocations",
        status: resp.status,
        details: raw.slice(0, 500),
      });
    }

    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    const allocationCount = await OrderAllocation.countDocuments({
      orderId: String(orderId),
    });

    return res.json({
      ok: true,
      orderId: String(orderId),
      allocationCount,
      resultCount: Array.isArray(parsed) ? parsed.length : null,
    });
  } catch (err) {
    console.error("❌ Error in POST /api/order-allocations/rebuild-order:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to rebuild order allocations",
      details: err.message,
    });
  }
});

export default router;