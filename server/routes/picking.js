import express from "express";

import { OrderAllocation } from "../models/OrderAllocation.js";
import { recordCompletedOperation } from "../services/operationRuns.js";

const router = express.Router();

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBoolean(value) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function normalizeLocation(location) {
  const populatedBin = location?.bin && typeof location.bin === "object" ? location.bin : null;
  return {
    binId: populatedBin?._id || location?.bin || null,
    binName: populatedBin?.name || "Unassigned",
    row: location?.row ?? null,
    quantity: Number(location?.quantity || 0),
  };
}

function serializeAllocation(allocation) {
  const item = allocation.inventoryItemId || null;
  const locations = Array.isArray(allocation.pickedLocations)
    ? allocation.pickedLocations.map(normalizeLocation)
    : [];

  return {
    id: allocation._id,
    source: allocation.source,
    orderId: allocation.orderId,
    orderCode: allocation.orderCode || allocation.orderId,
    orderItemId: allocation.orderItemId,
    marketplaceOrderItemId: allocation.marketplaceOrderItemId,
    name: allocation.name || item?.name || "Unknown card",
    setCode: item?.setCode || null,
    condition: allocation.condition || item?.condition || null,
    isFoil: allocation.isFoil ?? item?.isFoil ?? false,
    imageUrl: item?.imageUrl || null,
    requestedQuantity: allocation.requestedQuantity,
    fulfilledQuantity: allocation.fulfilledQuantity,
    status: allocation.status,
    failureReason: allocation.failureReason,
    picked: !!allocation.picked,
    pickedAt: allocation.pickedAt || null,
    pickedBy: allocation.pickedBy || null,
    locations,
    primaryLocation: locations[0] || null,
    createdAt: allocation.createdAt,
  };
}

router.get("/queue", async (req, res) => {
  try {
    const filter = {
      status: { $in: ["allocated", "manual_review"] },
    };

    if (["cardtrader", "manapool"].includes(req.query.source)) {
      filter.source = req.query.source;
    }

    if (req.query.mode === "exceptions") {
      filter.status = "manual_review";
    } else {
      const picked = normalizeBoolean(req.query.picked);
      if (picked !== null) filter.picked = picked;
      if (req.query.mode === "active") filter.status = "allocated";
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search).slice(0, 100), "i");
      filter.$or = [{ name: regex }, { orderCode: regex }, { orderId: regex }];
    }

    const requestedLimit = Number(req.query.limit || 1000);
    const limit = Math.min(2000, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 1000));

    const allocations = await OrderAllocation.find(filter)
      .populate("pickedLocations.bin", "name")
      .populate("inventoryItemId", "name setCode condition isFoil imageUrl locations")
      .sort({ picked: 1, createdAt: 1 })
      .limit(limit)
      .lean();

    const items = allocations.map(serializeAllocation);
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === "manual_review" ? -1 : 1;
      const aBin = a.primaryLocation?.binName || "ZZZ";
      const bBin = b.primaryLocation?.binName || "ZZZ";
      const binCompare = aBin.localeCompare(bBin, undefined, { numeric: true });
      if (binCompare) return binCompare;
      const rowCompare = Number(a.primaryLocation?.row || 999) - Number(b.primaryLocation?.row || 999);
      if (rowCompare) return rowCompare;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const summary = items.reduce(
      (acc, item) => {
        acc.lines += 1;
        acc.cards += Number(item.requestedQuantity || 0);
        if (item.picked) acc.pickedLines += 1;
        else acc.unpickedLines += 1;
        if (item.status === "manual_review") acc.exceptions += 1;
        if (item.source === "cardtrader") acc.cardtrader += 1;
        if (item.source === "manapool") acc.manapool += 1;
        return acc;
      },
      {
        lines: 0,
        cards: 0,
        pickedLines: 0,
        unpickedLines: 0,
        exceptions: 0,
        cardtrader: 0,
        manapool: 0,
      }
    );

    res.json({ items, summary, truncated: allocations.length >= limit });
  } catch (error) {
    console.error("Failed to build picking queue", error);
    res.status(500).json({ error: "Failed to build picking queue" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const picked = normalizeBoolean(req.body?.picked);
    if (picked === null) return res.status(400).json({ error: "picked must be a boolean" });

    const allocation = await OrderAllocation.findById(req.params.id);
    if (!allocation) return res.status(404).json({ error: "Allocation not found" });
    if (allocation.status !== "allocated") {
      return res.status(409).json({ error: "Only allocated lines can be picked" });
    }

    allocation.picked = picked;
    allocation.pickedAt = picked ? new Date() : null;
    allocation.pickedBy = picked ? String(req.body?.pickedBy || "local") : null;
    await allocation.save();

    res.json({ ok: true, item: serializeAllocation(allocation.toObject()) });
  } catch (error) {
    console.error("Failed to update picking line", error);
    res.status(500).json({ error: "Failed to update picking line" });
  }
});

router.post("/batch", async (req, res) => {
  const startedAt = new Date();

  try {
    const allocationIds = Array.isArray(req.body?.allocationIds)
      ? [...new Set(req.body.allocationIds.map(String))].slice(0, 1000)
      : [];
    const picked = normalizeBoolean(req.body?.picked);

    if (!allocationIds.length) return res.status(400).json({ error: "No allocation IDs supplied" });
    if (picked === null) return res.status(400).json({ error: "picked must be a boolean" });

    const update = picked
      ? {
          picked: true,
          pickedAt: new Date(),
          pickedBy: String(req.body?.pickedBy || "local"),
        }
      : { picked: false, pickedAt: null, pickedBy: null };

    const result = await OrderAllocation.updateMany(
      { _id: { $in: allocationIds }, status: "allocated" },
      { $set: update }
    );

    await recordCompletedOperation({
      kind: "picking-batch",
      label: picked ? "Marked picking lines complete" : "Reopened picking lines",
      source: "inventory",
      trigger: "manual",
      initiatedBy: String(req.body?.pickedBy || "local"),
      startedAt,
      summary: {
        requested: allocationIds.length,
        matched: result.matchedCount,
        modified: result.modifiedCount,
        picked,
      },
    });

    res.json({
      ok: true,
      requested: allocationIds.length,
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error) {
    console.error("Failed to batch update picking lines", error);
    res.status(500).json({ error: "Failed to batch update picking lines" });
  }
});

export { escapeRegex, normalizeBoolean };
export default router;
