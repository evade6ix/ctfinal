// server/utils/applyStagedToInventory.js
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

function buildInventoryLookup(staged) {
  const cardTraderId = Number(staged?.cardTraderId);

  if (Number.isFinite(cardTraderId) && cardTraderId > 0) {
    return { cardTraderId };
  }

  const blueprintId = Number(staged?.blueprintId);

  if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
    throw new Error(
      "applyStagedToInventory: staged.cardTraderId or staged.blueprintId is required"
    );
  }

  return {
    $and: [
      {
        $or: [
          { cardTraderId: { $exists: false } },
          { cardTraderId: null },
          { cardTraderId: 0 },
        ],
      },
      { blueprintId },
      { setCode: staged.setCode || "" },
      { game: staged.game || "" },
      { condition: staged.condition || "NM" },
      { isFoil: !!staged.isFoil },
    ],
  };
}

export async function applyStagedToInventory(staged, binId, row) {
  if (!staged) {
    throw new Error("applyStagedToInventory: staged item is required");
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
  const lookup = buildInventoryLookup(staged);

  let inv = await InventoryItem.findOne(lookup);

  if (!inv) {
    const cardTraderId = Number(staged.cardTraderId);
    const blueprintId = Number(staged.blueprintId);

    const createPayload = {
      blueprintId: Number.isFinite(blueprintId) ? blueprintId : null,
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
    };

    if (Number.isFinite(cardTraderId) && cardTraderId > 0) {
      createPayload.cardTraderId = cardTraderId;
    }

    inv = await InventoryItem.create(createPayload);
    return inv;
  }

  const stagedCardTraderId = Number(staged.cardTraderId);
  const stagedBlueprintId = Number(staged.blueprintId);

  if (Number.isFinite(stagedCardTraderId) && stagedCardTraderId > 0) {
    inv.cardTraderId = stagedCardTraderId;
  }

  if (Number.isFinite(stagedBlueprintId) && stagedBlueprintId > 0) {
    inv.blueprintId = stagedBlueprintId;
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
