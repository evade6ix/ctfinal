import mongoose from "mongoose";

const syncStateSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },

    // For CardTrader orders
    lastCardtraderOrderId: { type: Number },
    lastCardtraderOrderCreatedAt: { type: Date },
  },
  { timestamps: true }
);

export const SyncState = mongoose.model("SyncState", syncStateSchema);
