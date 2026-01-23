// server/models/Order.js
import mongoose from "mongoose";

const { Schema } = mongoose;

// One line item on an order
const OrderItemSchema = new Schema(
  {
    // Link to your InventoryItem so we know what bins to touch later
    inventoryItem: {
      type: Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    // Optional display fields so the Orders tab looks nice without extra queries
    name: String,
    setCode: String,
    condition: String,
    isFoil: Boolean,
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    // CardTrader order id (string for safety)
    externalId: {
      type: String,
      index: true,
    },

    // e.g. "cardtrader"
    marketplace: {
      type: String,
      default: "cardtrader",
    },

    // Open = not processed yet, fulfilled = we already deducted bins
    status: {
      type: String,
      enum: ["open", "fulfilled"],
      default: "open",
      index: true,
    },

    buyer: {
      nickname: String,
      country: String,
    },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    items: {
      type: [OrderItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

export const Order = mongoose.model("Order", OrderSchema);
