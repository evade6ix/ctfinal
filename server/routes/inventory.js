import express from "express";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const search = (req.query.search || "").trim();

    const filter = {};

    if (search) {
      const or = [
        { name: { $regex: search, $options: "i" } },
        { setCode: { $regex: search, $options: "i" } },
        { game: { $regex: search, $options: "i" } },
      ];

      const asNumber = Number(search);
      if (!Number.isNaN(asNumber)) {
        or.push({ cardTraderId: asNumber });
      }

      filter.$or = or;
    }

    // 👉 NO pagination here: return ALL matching items
    const items = await InventoryItem.find(filter)
      .sort({ name: 1 })
      .lean();

    const total = items.length;

    // Optional: server-calculated filter options (if you want to use them)
    const distinctSetCodes = [
      ...new Set(items.map((i) => i.setCode).filter(Boolean)),
    ].sort();
    const distinctGames = [
      ...new Set(items.map((i) => i.game).filter(Boolean)),
    ].sort();

    res.json({
      items,
      total,
      // these are for your UI filters if you want them
      sets: distinctSetCodes,
      games: distinctGames,
    });
  } catch (err) {
    console.error("Error fetching inventory:", err);
    res.status(500).json({ error: "Failed to fetch inventory" });
  }
});


router.post("/:id/add", async (req, res) => {
  const { id } = req.params;
  const { quantity, condition, price } = req.body;

  const qty = Number(quantity);

  if (!qty || Number.isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: "Invalid quantity" });
  }

  try {
    const update = {
      $inc: { totalQuantity: qty },
    };

    if (condition) {
      update.$set = { ...(update.$set || {}), condition };
    }

    if (typeof price === "number" && !Number.isNaN(price)) {
      update.$set = { ...(update.$set || {}), price };
    }

    const updated = await InventoryItem.findByIdAndUpdate(id, update, {
      new: true,
    });

    if (!updated) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json({ ok: true, item: updated });
  } catch (err) {
    console.error("Error adding inventory quantity:", err);
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

// POST /api/inventory  (simple create)
router.post("/", async (req, res) => {
  try {
    const {
      cardTraderId,
      game,
      setCode,
      name,
      condition,
      isFoil,
      price,
      totalQuantity,
    } = req.body;

    if (totalQuantity == null) {
      return res.status(400).json({ error: "totalQuantity is required" });
    }

    const item = await InventoryItem.create({
      cardTraderId,
      game,
      setCode,
      name,
      condition,
      isFoil,
      price,
      totalQuantity,
      locations: [], // no bin yet
    });

    res.status(201).json(item);
  } catch (err) {
    console.error("Error creating inventory item:", err);
    res.status(500).json({ error: "Failed to create inventory item" });
  }
});

/**
 * POST /api/inventory/bulk-assign
 * Body: {
 *   binId: string,
 *   row: number (1–5),
 *   items: [
 *     {
 *       cardTraderId: number | string,
 *       name?: string,
 *       game?: string,
 *       setCode?: string,
 *       condition?: string,
 *       isFoil?: boolean,
 *       price?: number,
 *       quantity: number
 *     }
 *   ]
 * }
 */
router.post("/bulk-assign", async (req, res) => {
  try {
    const { items, binId, row } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required" });
    }

    if (!binId || !mongoose.Types.ObjectId.isValid(binId)) {
      return res.status(400).json({ error: "Valid binId is required" });
    }

    const rowNum = Number(row);
    if (!Number.isFinite(rowNum) || rowNum < 1 || rowNum > 5) {
      return res
        .status(400)
        .json({ error: "row must be a number between 1 and 5" });
    }

    let updated = 0;
    const errors = [];

    for (const raw of items) {
      try {
        const cardTraderId = Number(raw.cardTraderId ?? raw.id);
        const qty = Number(raw.quantity);

        if (!Number.isFinite(cardTraderId) || cardTraderId <= 0) {
          errors.push({ item: raw, reason: "invalid cardTraderId" });
          continue;
        }

        if (!Number.isFinite(qty) || qty <= 0) {
          errors.push({ item: raw, reason: "invalid quantity" });
          continue;
        }

        // Find existing inventory row for this listing
        let doc = await InventoryItem.findOne({ cardTraderId });

        // If none exists, create a new one
        if (!doc) {
          doc = new InventoryItem({
            cardTraderId,
            game: raw.game ?? null,
            setCode: raw.setCode ?? null,
            name: raw.name ?? "",
            condition: raw.condition ?? "NM",
            isFoil: !!raw.isFoil,
            price:
              typeof raw.price === "number" && Number.isFinite(raw.price)
                ? raw.price
                : undefined,
            totalQuantity: 0,
            locations: [],
          });
        }

        // Update total quantity
        doc.totalQuantity += qty;

        // Either bump existing location (same bin + row) or push a new one
        const existingLoc = doc.locations.find(
          (loc) =>
            String(loc.bin) === String(binId) &&
            Number(loc.row) === rowNum
        );

        if (existingLoc) {
          existingLoc.quantity += qty;
        } else {
          doc.locations.push({
            bin: binId,
            row: rowNum,
            quantity: qty,
          });
        }

        await doc.save();
        updated += 1;
      } catch (err) {
        console.error("bulk-assign item error", err);
        errors.push({
          item: raw,
          reason: err?.message || "save_failed",
        });
      }
    }

    return res.json({
      ok: true,
      attempted: items.length,
      updated,
      failed: items.length - updated,
      errors,
    });
  } catch (err) {
    console.error("bulk-assign error", err);
    return res.status(500).json({
      error: "bulk_assign_failed",
      details: err?.message || String(err),
    });
  }
});

/**
 * POST /api/inventory/assign-unassigned-set-to-bin
 * Body: {
 *   setCode: string,
 *   binId: string (Bin _id),
 *   row: number (1–5)
 * }
 *
 * For every InventoryItem in this setCode:
 *   - compute unassigned = totalQuantity - sum(locations[].quantity)
 *   - if unassigned > 0, add that amount to the given bin+row
 *   - totalQuantity is NOT changed (we're just placing stock in bins)
 */
router.post("/assign-unassigned-set-to-bin", async (req, res) => {
  try {
    const { setCode, binId, row } = req.body || {};

    if (!setCode) {
      return res.status(400).json({ error: "setCode is required" });
    }

    if (!binId || !mongoose.Types.ObjectId.isValid(binId)) {
      return res.status(400).json({ error: "Valid binId is required" });
    }

    const rowNum = Number(row);
    if (!Number.isFinite(rowNum) || rowNum < 1 || rowNum > 5) {
      return res
        .status(400)
        .json({ error: "row must be a number between 1 and 5" });
    }

    // Find all inventory items for that set
    const items = await InventoryItem.find({ setCode });

    let affectedItems = 0;
    let totalMoved = 0;

    for (const item of items) {
      const total = Number(item.totalQuantity) || 0;
      const locations = Array.isArray(item.locations) ? item.locations : [];

      const alreadyAssigned = locations.reduce(
        (sum, loc) => sum + (Number(loc.quantity) || 0),
        0
      );

      const unassigned = total - alreadyAssigned;
      if (unassigned <= 0) {
        continue;
      }

      // If there's already a location for this bin+row, just bump it
      const existingLoc = locations.find(
        (loc) =>
          String(loc.bin) === String(binId) &&
          Number(loc.row) === rowNum
      );

      if (existingLoc) {
        existingLoc.quantity += unassigned;
      } else {
        locations.push({
          bin: binId,
          row: rowNum,
          quantity: unassigned,
        });
      }

      item.locations = locations;
      // totalQuantity stays the same – we're only assigning physical locations
      await item.save();

      affectedItems += 1;
      totalMoved += unassigned;
    }

    return res.json({
      ok: true,
      setCode,
      binId,
      row: rowNum,
      affectedItems,
      totalMoved,
    });
  } catch (err) {
    console.error("assign-unassigned-set-to-bin error", err);
    return res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/inventory/:id
 * Return a single inventory item with ALL locations (all bins + rows),
 * with bins populated (name, rows, description).
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid item ID" });
  }

  try {
    const item = await InventoryItem.findById(id)
      .populate("locations.bin", "name rows description")
      .lean();

    if (!item) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.json(item);
  } catch (err) {
    console.error("Error fetching inventory item:", err);
    return res.status(500).json({ error: "Failed to fetch inventory item" });
  }
});

export default router;
