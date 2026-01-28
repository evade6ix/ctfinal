import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    bin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bin",
      required: true
    },
    row: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    quantity: {
      type: Number,
      required: true,
      min: 0
    }
  },
  { _id: false }
);

const inventoryItemSchema = new mongoose.Schema(
  {
    // CardTrader / card identifiers
    cardTraderId: { type: Number, index: true },

    // For linking to CT blueprints
    blueprintId: { type: Number, index: true },

    game: { type: String },
    setCode: { type: String },
    name: { type: String },

    // Image from CardTrader blueprint
    imageUrl: { type: String, default: null },   // 👈 NEW FIELD

    // Pricing info from CardTrader
    condition: { type: String },
    isFoil: { type: Boolean, default: false },
    price: { type: Number },

    // Quantity & locations
    totalQuantity: { type: Number, required: true, min: 0 },
    locations: {
      type: [locationSchema],
      default: []
    },

    // For your future expansion
    notes: { type: String }
  },
  { timestamps: true }
);

export const InventoryItem = mongoose.model(
  "InventoryItem",
  inventoryItemSchema
);
