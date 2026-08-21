import express from "express";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid inventory item ID",
      });
    }

    const deleted = await InventoryItem.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        ok: false,
        error: "Inventory item not found",
      });
    }

    return res.json({
      ok: true,
      deleted: {
        id: String(deleted._id),
        name: deleted.name || "",
        cardTraderId: deleted.cardTraderId ?? null,
        blueprintId: deleted.blueprintId ?? null,
        totalQuantity: Number(deleted.totalQuantity) || 0,
        locationCount: Array.isArray(deleted.locations)
          ? deleted.locations.length
          : 0,
      },
    });
  } catch (err) {
    console.error("Error deleting Card List inventory item:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete inventory item",
      details: err?.message || String(err),
    });
  }
});

export default router;
