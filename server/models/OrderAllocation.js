// server/models/OrderAllocation.js
import mongoose from "mongoose";

const orderAllocationSchema = new mongoose.Schema(
  {
    // CardTrader order id (we store as string for consistency)
    orderId: {
      type: String,
      required: true,
      index: true,
    },

    // CardTrader product id for this line
    cardTraderId: {
      type: Number,
      required: true,
      index: true,
    },

    // Optional extras (keep these flexible so we don't break anything):
    blueprintId: {
      type: Number,
    },
    name: {
      type: String,
    },

    // How many copies this allocation represents
    quantity: {
      type: Number,
      required: true,
    },

    // Bin + row we’re pulling from
    bin: {
      type: String,
    },
    row: {
      type: Number,
    },

    // Picking state
    picked: {
      type: Boolean,
      default: false,
      index: true,
    },
    pickedAt: {
      type: Date,
    },
    pickedBy: {
      type: String,
    },
  },
  {
    timestamps: true,
    // Allow extra fields just in case your existing allocations
    // already have other properties we’re not explicitly modeling.
    strict: false,
  }
);

// Useful index when we look up a line for a specific order + CT product
orderAllocationSchema.index({ orderId: 1, cardTraderId: 1 });

export const OrderAllocation = mongoose.model(
  "OrderAllocation",
  orderAllocationSchema
);
