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
    return null;
  }

  const binObjectId = new mongoose.Types.ObjectId(binId);

  let inv = await InventoryItem.findOne({ cardTraderId: staged.cardTraderId });

  if (!inv) {
    inv = await InventoryItem.create({
      cardTraderId: staged.cardTraderId,
      blueprintId: staged.blueprintId || null,
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

    return inv;
  }

  if (staged.blueprintId) {
    inv.blueprintId = staged.blueprintId;
  }

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

  if (!found) {
    inv.locations.push({
      bin: binObjectId,
      row: numericRow,
      quantity: qty,
    });
  }

  const currentTotal = Number(inv.totalQuantity) || 0;
  inv.totalQuantity = currentTotal + qty;

  inv.markModified("locations");

  await inv.save();

  return inv;
}