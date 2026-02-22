// server/utils/applyStagedToInventory.js
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

export async function applyStagedToInventory(staged, binId, row) {
  if (!staged || !staged.cardTraderId) {
    throw new Error("applyStagedToInventory: staged.cardTraderId is required");
  }
  if (!binId) {
    throw new Error("applyStagedToInventory: binId is required");
  }

 const numericRow = Number(row);
if (!Number.isFinite(numericRow) || numericRow < 1) {
  throw new Error("applyStagedToInventory: row must be >= 1");
}

  const qty = Number(staged.quantity) || 0;
  if (qty <= 0) {
    // nothing to add
    return;
  }

  // Always cast binId → ObjectId so it matches how we query with "locations.bin": binId
  const binObjectId = new mongoose.Types.ObjectId(binId);

  // Try to load existing inventory item for this CardTrader listing
  let inv = await InventoryItem.findOne({ cardTraderId: staged.cardTraderId });

  // If none exists, create a brand-new document with one location
  if (!inv) {
    inv = await InventoryItem.create({
      cardTraderId: staged.cardTraderId,
      name: staged.name || "",
      setCode: staged.setCode || "",
      game: staged.game || "",
      condition: staged.condition || "NM",
      isFoil: !!staged.isFoil,
      price:
        staged.price != null && Number.isFinite(Number(staged.price))
          ? Number(staged.price)
          : 0,
      totalQuantity: qty,
      locations: [
        {
          bin: binObjectId,
          row: numericRow,
          quantity: qty,
        },
      ],
    });

    // done
    return;
  }

  // We have an existing item → update its metadata & locations
  inv.name = staged.name || inv.name || "";
  inv.setCode = staged.setCode || inv.setCode || "";
  inv.game = staged.game || inv.game || "";
  inv.condition = staged.condition || inv.condition || "NM";
  inv.isFoil =
    typeof staged.isFoil === "boolean" ? staged.isFoil : !!inv.isFoil;

  if (
    staged.price != null &&
    Number.isFinite(Number(staged.price)) &&
    Number(staged.price) > 0
  ) {
    inv.price = Number(staged.price);
  }

  if (!Array.isArray(inv.locations)) {
    inv.locations = [];
  }

  // Look for an existing location for THIS bin + row
let found = false;
for (const loc of inv.locations) {
  if (
    String(loc.bin) === String(binObjectId) &&
    Number(loc.row) === numericRow
  ) {
    const currentLocQty = Number(loc.quantity) || 0;
    loc.quantity = currentLocQty + qty;
    found = true;
    break;
  }
}
  // If no matching location, push a new one
  if (!found) {
    inv.locations.push({
      bin: binObjectId,
      row: numericRow,
      quantity: qty,
    });
  }

  // Bump totalQuantity
  const currentTotal = Number(inv.totalQuantity) || 0;
  inv.totalQuantity = currentTotal + qty;

  inv.markModified("locations");
  await inv.save();
}
