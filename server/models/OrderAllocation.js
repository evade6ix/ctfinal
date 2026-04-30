// server/models/OrderAllocation.js
import mongoose from "mongoose";

const pickedLocationSchema = new mongoose.Schema(
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
      min: 1,
    },
  },
  { _id: false }
);

const orderAllocationSchema = new mongoose.Schema(
  {
    // CardTrader order id (numeric) – we store as string to be safe
    orderId: {
      type: String,
      required: true,
      index: true,
    },

    // Optional: CT order code like "20260123XXXX"
    orderCode: {
      type: String,
    },

        // Exact CardTrader order line id
    // This makes allocations unique per card line, not just per card/listing.
    orderItemId: {
      type: Number,
      required: true,
      index: true,
    },

    // Which CardTrader product/listing this allocation is for
    cardTraderId: {
      type: Number,
      required: true,
      index: true,
    },

    // ✅ NEW: snapshot data from the CT order line
    name: {
      type: String,
    },
    condition: {
      type: String,
    },
    isFoil: {
      type: Boolean,
      default: false,
    },

    // How many the order line requested in total
    requestedQuantity: {
      type: Number,
      required: true,
      min: 1,
    },

    // How many we actually fulfilled from bins
    fulfilledQuantity: {
      type: Number,
      required: true,
      min: 0,
    },

    // If > 0, we didn’t have enough stock in bins
    unfilled: {
      type: Number,
      default: 0,
    },

    // Exactly which bins/rows we pulled from
    pickedLocations: {
      type: [pickedLocationSchema],
      default: [],
    },

    // 🔽🔽 NEW: UI “picked” toggle for that line 🔽🔽
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
  { timestamps: true }
);

// One allocation per exact CardTrader order line
orderAllocationSchema.index({ orderId: 1, orderItemId: 1 }, { unique: true });

// Helpful lookup for older UI/search flows
orderAllocationSchema.index({ orderId: 1, cardTraderId: 1 });

export const OrderAllocation = mongoose.model(
  "OrderAllocation",
  orderAllocationSchema
);