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
      max: 5,
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

    // Which listing this allocation is for
    cardTraderId: {
      type: Number,
      required: true,
      index: true,
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
  },
  { timestamps: true }
);

// One allocation per order + cardTraderId
orderAllocationSchema.index({ orderId: 1, cardTraderId: 1 }, { unique: true });

export const OrderAllocation = mongoose.model(
  "OrderAllocation",
  orderAllocationSchema
);
