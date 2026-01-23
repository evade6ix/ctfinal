import mongoose from "mongoose";

const binSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true, // e.g. "Bin A", "Bin B2"
      trim: true
    },
    rows: {
      type: Number,
      required: true,
      min: 1,
      max: 5 // as requested
    },
    description: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

export const Bin = mongoose.model("Bin", binSchema);
