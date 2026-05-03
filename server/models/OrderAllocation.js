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
    orderId: {
      type: String,
      required: true,
      index: true,
    },

    orderCode: {
      type: String,
      index: true,
    },

    orderItemId: {
      type: Number,
      required: true,
      index: true,
    },

    // Sold CardTrader listing/product ID from the order line
    cardTraderId: {
      type: Number,
      required: true,
      index: true,
    },

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

    requestedQuantity: {
      type: Number,
      required: true,
      min: 1,
    },

    fulfilledQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    unfilled: {
      type: Number,
      default: 0,
    },

    pickedLocations: {
      type: [pickedLocationSchema],
      default: [],
    },

    // allocated = inventory was deducted
    // manual_review = exact CardTrader ID missing / not enough stock, no deduction
    // restored = inventory was restored later
    // cancelled = order/allocation cancelled without active deduction
    // shipped = kept for history after shipment
    status: {
      type: String,
      enum: ["allocated", "manual_review", "restored", "cancelled", "shipped"],
      default: "allocated",
      index: true,
    },

    failureReason: {
      type: String,
      default: null,
    },

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

// One allocation/review record per exact CardTrader order line
orderAllocationSchema.index({ orderId: 1, orderItemId: 1 }, { unique: true });

// Helpful lookup for older UI/search flows
orderAllocationSchema.index({ orderId: 1, cardTraderId: 1 });

export const OrderAllocation = mongoose.model(
  "OrderAllocation",
  orderAllocationSchema
);