import mongoose from "mongoose";

const catalogSetCacheSchema = new mongoose.Schema(
  {
    gameId: { type: Number, required: true, index: true },
    expansionId: { type: Number, required: true, unique: true, index: true },
    setCode: { type: String, default: "", index: true },
    setName: { type: String, default: "" },
    blueprintCount: { type: Number, default: 0 },
    blueprints: { type: [mongoose.Schema.Types.Mixed], default: [] },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

catalogSetCacheSchema.index({ gameId: 1, expansionId: 1 });
catalogSetCacheSchema.index({ gameId: 1, setCode: 1 });

export const CatalogSetCache = mongoose.model(
  "CatalogSetCache",
  catalogSetCacheSchema
);
