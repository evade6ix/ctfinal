// server/routes/bins.js
import express from "express";
import { Bin } from "../models/Bin.js";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

// GET all bins
router.get("/", async (req, res) => {
  try {
    const bins = await Bin.find().sort({ createdAt: 1 });
    res.json(bins);
  } catch (err) {
    console.error("Error fetching bins:", err);
    res.status(500).json({ error: "Failed to fetch bins" });
  }
});

// Create a new bin
router.post("/", async (req, res) => {
  try {
    const { name, rows, description } = req.body;
    if (!name || !rows) {
      return res.status(400).json({ error: "name and rows are required" });
    }

    const bin = await Bin.create({ name, rows, description });
    res.status(201).json(bin);
  } catch (err) {
    console.error("Error creating bin:", err);
    res.status(500).json({ error: "Failed to create bin" });
  }
});

// Get items in a single bin (for UI)
router.get("/:binId/items", async (req, res) => {
  try {
    const { binId } = req.params;

    // 1) Find all inventory items that have at least one location in this bin
    const items = await InventoryItem.find(
      { "locations.bin": binId },
      {
        cardTraderId: 1,
        game: 1,
        setCode: 1,
        name: 1,
        condition: 1,
        isFoil: 1,
        price: 1,
        totalQuantity: 1,
        locations: 1,
        notes: 1,
      }
    )
      .populate("locations.bin", "name rows") // so UI can show bin info if needed
      .lean();

    // 2) Filter each item's locations array so it only includes this bin
    //    and compute quantity + value for THIS bin only
    const itemsWithFilteredLocations = items.map((item) => {
      const filteredLocations = (item.locations || []).filter((loc) => {
        if (!loc.bin) return false;

        // loc.bin may be an ObjectId or a populated object with _id
        const locBinId =
          typeof loc.bin === "object" && loc.bin._id
            ? String(loc.bin._id)
            : String(loc.bin);

        return locBinId === String(binId);
      });

      // quantity of this card in THIS bin
      const qtyInBin = filteredLocations.reduce(
        (sum, loc) => sum + (loc.quantity || 0),
        0
      );

      // price is per card (in your currency units, e.g. C$)
      const price = typeof item.price === "number" ? item.price : 0;

      // store value in cents to avoid float issues, plus a formatted string
      const valueInBinCents = Math.round(price * 100 * qtyInBin);
      const valueInBin = "C$" + (valueInBinCents / 100).toFixed(2);

      return {
        ...item,
        locations: filteredLocations,
        qtyInBin,
        valueInBinCents,
        valueInBin,
      };
    });

    res.json(itemsWithFilteredLocations);
  } catch (err) {
    console.error("Error fetching bin items:", err);
    res.status(500).json({ error: "Failed to fetch bin items" });
  }
});

export default router;
