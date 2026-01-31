// server/routes/orderAllocations.js
import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

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

export default router;
