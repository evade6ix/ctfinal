import mongoose from "mongoose";

const operationRunSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      default: "system",
      index: true,
    },
    trigger: {
      type: String,
      default: "automatic",
    },
    status: {
      type: String,
      enum: ["running", "completed", "completed_with_errors", "failed"],
      default: "running",
      index: true,
    },
    initiatedBy: {
      type: String,
      default: "system",
    },
    startedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    finishedAt: {
      type: Date,
      default: null,
    },
    durationMs: {
      type: Number,
      default: null,
    },
    summary: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    errorDetails: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  { timestamps: true }
);

operationRunSchema.index({ kind: 1, startedAt: -1 });
operationRunSchema.index({ status: 1, startedAt: -1 });

export const OperationRun = mongoose.model("OperationRun", operationRunSchema);
