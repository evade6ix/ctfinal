import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

function sourceFilter() {
  return { $or: [{ source: "cardtrader" }, { source: { $exists: false } }] };
}

// Compatibility list for all empty CardTrader manual-review records. Older
// records may have fulfilledQuantity or pickedLocations missing/null, so the
// original exact `fulfilledQuantity: 0` query could hide a visibly unassigned
// Daily Sales line from the rescue screen.
router.get("/", async (_req, res) => {
  try {
    const docs = await OrderAllocation.find({
      $and: [
        sourceFilter(),
        { status: "manual_review" },
        {
          $or: [
            { fulfilledQuantity: 0 },
            { fulfilledQuantity: null },
            { fulfilledQuantity: { $exists: false } },
          ],
        },
        {
          $or: [
            { pickedLocations: { $size: 0 } },
            { pickedLocations: null },
            { pickedLocations: { $exists: false } },
          ],
        },
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
        requestedQuantity: Number(doc.requestedQuantity || doc.unfilled || 0),
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

export default router;
