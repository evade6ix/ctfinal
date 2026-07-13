import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

function sourceFilter() {
  return { $or: [{ source: "cardtrader" }, { source: { $exists: false } }] };
}

router.post("/:allocationId/assign", async (req, res, next) => {
  try {
    const requested = await OrderAllocation.findById(req.params.allocationId).lean();
    if (!requested) return next();

    const siblings = await OrderAllocation.find({
      orderId: String(requested.orderId),
      orderItemId: Number(requested.orderItemId),
      ...sourceFilter(),
    }).lean();

    const allocated = siblings.find(
      (allocation) =>
        allocation.status === "allocated" &&
        Number(allocation.fulfilledQuantity || 0) > 0 &&
        Array.isArray(allocation.pickedLocations) &&
        allocation.pickedLocations.length > 0
    );

    if (!allocated) return next();

    const staleIds = siblings
      .filter(
        (allocation) =>
          allocation._id.toString() !== allocated._id.toString() &&
          allocation.status === "manual_review" &&
          Number(allocation.fulfilledQuantity || 0) === 0 &&
          (!Array.isArray(allocation.pickedLocations) ||
            allocation.pickedLocations.length === 0)
      )
      .map((allocation) => allocation._id);

    if (staleIds.length) {
      await OrderAllocation.deleteMany({ _id: { $in: staleIds } });
    }

    return res.json({
      ok: true,
      alreadyAllocated: true,
      allocationId: allocated._id.toString(),
      cleanedStaleManualReviews: staleIds.length,
      message:
        "The order line was already allocated. Empty duplicate manual-review records were removed without deducting inventory again.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
