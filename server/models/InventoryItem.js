import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    bin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bin",
      required: true,
    },
    row: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const identifiersSchema = new mongoose.Schema(
  {
    scryfallId: { type: String, default: null, index: true },
    mtgjsonUuid: { type: String, default: null },
    tcgplayerProductId: { type: String, default: null },
    tcgplayerSkuId: { type: String, default: null },
  },
  { _id: false }
);

const manaPoolSchema = new mongoose.Schema(
  {
    inventoryId: { type: String, default: null, index: true },
    productId: { type: String, default: null },
    productType: { type: String, default: null },
    tcgplayerSku: { type: String, default: null },

    scryfallId: { type: String, default: null, index: true },
    languageId: { type: String, default: "EN" },
    conditionId: { type: String, default: null },
    finishId: { type: String, default: null },

    customExternalId: { type: String, default: null, index: true },

    lastSyncedAt: { type: Date, default: null },
    lastSyncedQuantity: { type: Number, default: null },
    lastSyncedPriceCents: { type: Number, default: null },

    lastSyncError: { type: String, default: null },
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

    // Image from CardTrader blueprint / Scryfall
    imageUrl: { type: String, default: null },

    // Pricing info
    condition: { type: String },
    isFoil: { type: Boolean, default: false },
    price: { type: Number },

    // MTG-specific metadata
    mtgColors: { type: String, index: true },

    // External marketplace/product identifiers
    identifiers: {
      type: identifiersSchema,
      default: () => ({}),
    },

    manapool: {
      type: manaPoolSchema,
      default: () => ({}),
    },

    // Quantity & locations
    totalQuantity: { type: Number, required: true, min: 0 },
    locations: {
      type: [locationSchema],
      default: [],
    },

    notes: { type: String },
  },
  { timestamps: true }
);

inventoryItemSchema.index({ game: 1, setCode: 1, name: 1 });
inventoryItemSchema.index({ condition: 1, isFoil: 1 });
inventoryItemSchema.index({ totalQuantity: 1 });
inventoryItemSchema.index({ "locations.bin": 1, "locations.row": 1 });

export const InventoryItem = mongoose.model(
  "InventoryItem",
  inventoryItemSchema
);
