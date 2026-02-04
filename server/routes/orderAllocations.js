// server/routes/orderAllocations.js
import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { ct } from "../ctClient.js";

const router = express.Router();

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
    res.status(500).json({ error: "Failed to load allocations for order" });
  }
});

/**
 * PATCH /api/order-allocations/pick
 * Body: { orderId: string | number, cardTraderId: number, pickedBy?: string }
 *
 * Marks THIS allocation as picked (does NOT touch inventory at all).
 */
router.patch("/pick", async (req, res) => {
  try {
    const { orderId, cardTraderId, pickedBy } = req.body || {};

    if (!orderId || typeof cardTraderId === "undefined") {
      return res
        .status(400)
        .json({ error: "orderId and cardTraderId are required" });
    }

    const filter = {
      orderId: String(orderId),
      cardTraderId: Number(cardTraderId),
    };

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
        error: "Allocation not found for given orderId + cardTraderId",
      });
    }

    res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/pick:", err);
    res.status(500).json({ error: "Failed to mark allocation as picked" });
  }
});

/**
 * PATCH /api/order-allocations/unpick
 * Body: { orderId: string | number, cardTraderId: number }
 *
 * Clears picked state (still no inventory changes).
 */
router.patch("/unpick", async (req, res) => {
  try {
    const { orderId, cardTraderId } = req.body || {};

    if (!orderId || typeof cardTraderId === "undefined") {
      return res
        .status(400)
        .json({ error: "orderId and cardTraderId are required" });
    }

    const filter = {
      orderId: String(orderId),
      cardTraderId: Number(cardTraderId),
    };

    const update = {
      picked: false,
      pickedAt: null,
      pickedBy: null,
    };

    const doc = await OrderAllocation.findOneAndUpdate(filter, update, {
      new: true,
    });

    if (!doc) {
      return res.status(404).json({
        error: "Allocation not found for given orderId + cardTraderId",
      });
    }

    res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/unpick:", err);
    res.status(500).json({ error: "Failed to clear picked state" });
  }
});

/**
 * POST /api/order-allocations/cleanup-stale
 *
 * Goes through all distinct orderIds in OrderAllocation and:
 *  - calls CardTrader /orders/:id
 *  - if order is 404 OR not in "paid" state, deletes all allocations for that orderId
 *
 * Run this after you ship your CardTrader Zero batch (or periodically).
 */
router.post("/cleanup-stale", async (req, res) => {
  try {
    const client = ct();

    const orderIds = await OrderAllocation.distinct("orderId");
    if (!orderIds.length) {
      return res.json({
        checkedOrders: 0,
        deletedOrders: 0,
        deletedAllocations: 0,
        errorsCount: 0,
        errors: [],
      });
    }

    let checked = 0;
    let deletedOrders = 0;
    let deletedAllocations = 0;
    const errors = [];

    for (const rawOrderId of orderIds) {
      const orderId = String(rawOrderId);
      checked++;

      let shouldDelete = false;

      try {
        const r = await client.get(`/orders/${orderId}`);
        const order = r.data || {};
        const stateRaw = (order.state || order.status || "").toString().toLowerCase();

        // You only care about "paid" orders for Zero picking.
        // Anything not paid is considered stale and we nuke allocations.
        if (stateRaw !== "paid") {
          shouldDelete = true;
        }
      } catch (err) {
        const status = err?.response?.status;

        // If CT says 404, that order is completely gone → delete allocations.
        if (status === 404) {
          shouldDelete = true;
        } else {
          errors.push({
            orderId,
            status,
            message: err.message || String(err),
          });
          // Skip deletion for this one, move on
          continue;
        }
      }

      if (shouldDelete) {
        const delResult = await OrderAllocation.deleteMany({ orderId });
        if (delResult?.deletedCount > 0) {
          deletedOrders++;
          deletedAllocations += delResult.deletedCount;
        }
      }
    }

    return res.json({
      checkedOrders: checked,
      deletedOrders,
      deletedAllocations,
      errorsCount: errors.length,
      errors,
    });
  } catch (err) {
    console.error("❌ Error in POST /api/order-allocations/cleanup-stale:", err);
    return res
      .status(500)
      .json({ error: "Failed to cleanup stale order allocations" });
  }
});

export default router;
