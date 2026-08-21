// server/models/ChangeLog.js
import mongoose from "mongoose";

const changeLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "inventory-sync",
        "inventory-adjust",
        "order-applied",
        "bin-change",
      ],
      required: true,
    },
    source: {
      type: String,
      enum: ["cardtrader", "manual", "system"],
      default: "system",
    },
    message: { type: String, required: true },

    // optional metadata
    orderId: { type: Number },
    cardTraderId: { type: Number },
    deltaQuantity: { type: Number },
    binId: { type: mongoose.Schema.Types.ObjectId, ref: "Bin" },
    details: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const ChangeLog = mongoose.model("ChangeLog", changeLogSchema);
