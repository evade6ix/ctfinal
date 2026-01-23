// server/models/ProcessedOrderLine.js
import mongoose from "mongoose";

const processedOrderLineSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    lineKey: { type: String, required: true, unique: true }, // e.g. "12345:987654"
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Helpful indexes
processedOrderLineSchema.index({ orderId: 1 });
processedOrderLineSchema.index({ lineKey: 1 }, { unique: true });

export const ProcessedOrderLine = mongoose.model(
  "ProcessedOrderLine",
  processedOrderLineSchema
);
