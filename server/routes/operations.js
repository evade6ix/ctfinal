import express from "express";
import mongoose from "mongoose";

import { Bin } from "../models/Bin.js";
import { ChangeLog } from "../models/ChangeLog.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { OperationRun } from "../models/OperationRun.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function inventorySnapshot() {
  const [snapshot] = await InventoryItem.aggregate([
    {
      $group: {
        _id: null,
        skuCount: { $sum: 1 },
        cardCount: { $sum: { $ifNull: ["$totalQuantity", 0] } },
        inventoryValue: {
          $sum: {
            $multiply: [
              { $ifNull: ["$totalQuantity", 0] },
              { $ifNull: ["$price", 0] },
            ],
          },
        },
        cardTraderListings: {
          $sum: { $cond: [{ $ne: ["$cardTraderId", null] }, 1, 0] },
        },
        manaPoolListings: {
          $sum: { $cond: [{ $ne: ["$manapool.inventoryId", null] }, 1, 0] },
        },
      },
    },
  ]);

  return {
    skuCount: snapshot?.skuCount || 0,
    cardCount: snapshot?.cardCount || 0,
    inventoryValue: Number(snapshot?.inventoryValue || 0),
    cardTraderListings: snapshot?.cardTraderListings || 0,
    manaPoolListings: snapshot?.manaPoolListings || 0,
  };
}

async function allocationSnapshot() {
  const groups = await OrderAllocation.aggregate([
    {
      $group: {
        _id: {
          source: "$source",
          status: "$status",
          picked: "$picked",
        },
        lines: { $sum: 1 },
        cards: { $sum: { $ifNull: ["$requestedQuantity", 0] } },
      },
    },
  ]);

  const result = {
    activeLines: 0,
    activeCards: 0,
    pickedLines: 0,
    unpickedLines: 0,
    exceptions: 0,
    bySource: { cardtrader: 0, manapool: 0 },
  };

  for (const group of groups) {
    const { source, status, picked } = group._id;
    if (status === "manual_review") result.exceptions += group.lines;
    if (status !== "allocated") continue;

    result.activeLines += group.lines;
    result.activeCards += group.cards;
    if (picked) result.pickedLines += group.lines;
    else result.unpickedLines += group.lines;
    if (source === "cardtrader" || source === "manapool") {
      result.bySource[source] += group.lines;
    }
  }

  return result;
}

async function integritySnapshot({ includeItems = false } = {}) {
  const limit = 100;
  const mismatchPipeline = [
    {
      $addFields: {
        locationQuantity: {
          $sum: {
            $map: {
              input: { $ifNull: ["$locations", []] },
              as: "location",
              in: { $ifNull: ["$$location.quantity", 0] },
            },
          },
        },
      },
    },
    {
      $match: {
        $expr: { $ne: ["$totalQuantity", "$locationQuantity"] },
      },
    },
  ];

  const [
    quantityMismatches,
    missingLocations,
    marketplaceErrors,
    invalidLocations,
    duplicateOrderLines,
  ] = await Promise.all([
    InventoryItem.aggregate([
      ...mismatchPipeline,
      {
        $facet: {
          count: [{ $count: "value" }],
          items: includeItems
            ? [
                { $sort: { name: 1 } },
                { $limit: limit },
                {
                  $project: {
                    name: 1,
                    setCode: 1,
                    condition: 1,
                    isFoil: 1,
                    totalQuantity: 1,
                    locationQuantity: 1,
                  },
                },
              ]
            : [{ $match: { _id: null } }],
        },
      },
    ]),
    InventoryItem.countDocuments({
      totalQuantity: { $gt: 0 },
      $or: [{ locations: { $exists: false } }, { locations: { $size: 0 } }],
    }),
    InventoryItem.countDocuments({
      "manapool.lastSyncError": { $exists: true, $nin: [null, ""] },
    }),
    InventoryItem.countDocuments({
      $or: [
        { totalQuantity: { $lt: 0 } },
        { "locations.quantity": { $lt: 0 } },
        { "locations.row": { $lt: 1 } },
        { "locations.row": { $gt: 100 } },
      ],
    }),
    OrderAllocation.aggregate([
      {
        $group: {
          _id: { source: "$source", orderId: "$orderId", orderItemId: "$orderItemId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: "value" },
    ]),
  ]);

  const mismatchFacet = quantityMismatches?.[0] || {};
  const mismatchCount = mismatchFacet.count?.[0]?.value || 0;
  const duplicateCount = duplicateOrderLines?.[0]?.value || 0;
  const issueCount =
    mismatchCount +
    missingLocations +
    marketplaceErrors +
    invalidLocations +
    duplicateCount;

  return {
    checkedAt: new Date().toISOString(),
    healthy: issueCount === 0,
    issueCount,
    quantityMismatches: {
      count: mismatchCount,
      items: includeItems ? mismatchFacet.items || [] : undefined,
    },
    missingLocations,
    marketplaceErrors,
    invalidLocations,
    duplicateOrderLines: duplicateCount,
  };
}

router.get("/summary", async (_req, res) => {
  try {
    const [inventory, allocations, integrity, binCount, recentRuns, recentChanges] =
      await Promise.all([
        inventorySnapshot(),
        allocationSnapshot(),
        integritySnapshot(),
        Bin.countDocuments(),
        OperationRun.find().sort({ startedAt: -1 }).limit(8).lean(),
        ChangeLog.find().sort({ createdAt: -1 }).limit(8).lean(),
      ]);

    const failedRuns = recentRuns.filter((run) =>
      ["failed", "completed_with_errors"].includes(run.status)
    ).length;

    res.json({
      generatedAt: new Date().toISOString(),
      database: {
        connected: mongoose.connection.readyState === 1,
        state: ["disconnected", "connected", "connecting", "disconnecting"]?.[
          mongoose.connection.readyState
        ] || "unknown",
      },
      system: {
        healthy: integrity.healthy && failedRuns === 0,
        failedRuns,
      },
      inventory: { ...inventory, binCount },
      allocations,
      integrity,
      recentRuns,
      recentChanges,
    });
  } catch (error) {
    console.error("Failed to build operations summary", error);
    res.status(500).json({ error: "Failed to build operations summary" });
  }
});

router.get("/integrity", async (_req, res) => {
  try {
    res.json(await integritySnapshot({ includeItems: true }));
  } catch (error) {
    console.error("Failed to scan inventory integrity", error);
    res.status(500).json({ error: "Failed to scan inventory integrity" });
  }
});

router.get("/runs", async (req, res) => {
  try {
    const page = boundedInt(req.query.page, 1, 1, 100000);
    const limit = boundedInt(req.query.limit, 25, 1, 100);
    const filter = {};

    if (req.query.kind) filter.kind = String(req.query.kind);
    if (req.query.status) filter.status = String(req.query.status);

    const [runs, total] = await Promise.all([
      OperationRun.find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      OperationRun.countDocuments(filter),
    ]);

    res.json({ runs, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    console.error("Failed to load operation runs", error);
    res.status(500).json({ error: "Failed to load operation runs" });
  }
});

export default router;
