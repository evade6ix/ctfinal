// server/scripts/reconcileAssignedToTotal.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";

// Resolve ROOT .env (D:\ctfinal\.env)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in ROOT .env");
  process.exit(1);
}

// CLI flag: --apply to actually save changes
const APPLY_CHANGES = process.argv.includes("--apply");

async function connectMongo() {
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo");
}

function getAssigned(locations = []) {
  return locations.reduce(
    (sum, loc) => sum + (Number(loc.quantity) || 0),
    0
  );
}

async function reconcileAssignedToTotal() {
  await connectMongo();

  console.log(
    `📏 Starting reconciliation (mode: ${APPLY_CHANGES ? "APPLY" : "DRY RUN"})`
  );

  // Items that have locations and some total field
  const cursor = InventoryItem.find({
    locations: { $exists: true, $ne: [] },
    $or: [
      { totalQuantity: { $ne: null } },
      { quantity: { $ne: null } },
    ],
  }).cursor();

  let checked = 0;
  let adjustedItems = 0;
  let totalCopiesRemoved = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    checked++;

    // 🔹 Use the same "total" the UI cares about:
    // 1) totalQuantity (your CT-synced / UI "Total qty")
    // 2) fallback to quantity if totalQuantity is missing
    const total =
      doc.totalQuantity != null
        ? Number(doc.totalQuantity) || 0
        : doc.quantity != null
        ? Number(doc.quantity) || 0
        : 0;

    const assignedBefore = getAssigned(doc.locations);

    if (assignedBefore <= total) {
      // Already consistent
      continue;
    }

    const toRemove = assignedBefore - total;
    adjustedItems++;
    totalCopiesRemoved += toRemove;

    console.log(
      `\n🧮 ${doc.name || "Unknown card"} (${doc.setCode || "no set"})`
    );
    console.log(
      `   Assigned: ${assignedBefore}, Total: ${total} → need to remove ${toRemove}`
    );

    // Clone locations so we can safely mutate
    const locations = doc.locations.map((loc) => ({
      ...loc,
      quantity: Number(loc.quantity) || 0,
    }));

    let remainingToRemove = toRemove;

    // LIFO: trim from the last locations first
    for (let i = locations.length - 1; i >= 0 && remainingToRemove > 0; i--) {
      const loc = locations[i];
      if (!loc || loc.quantity <= 0) continue;

      const removeHere = Math.min(loc.quantity, remainingToRemove);
      const before = loc.quantity;
      const after = before - removeHere;

      console.log(
        `   - Bin ${loc.bin?.label || loc.bin?.name || loc.bin || "?"}, row ${
          loc.row ?? "?"
        }: ${before} → ${after}`
      );

      loc.quantity = after;
      remainingToRemove -= removeHere;
    }

    if (remainingToRemove > 0) {
      console.warn(
        `   ⚠ Still ${remainingToRemove} left to remove after trimming all locations.`
      );
    }

    const cleanedLocations = locations.filter((loc) => loc.quantity > 0);
    const assignedAfter = getAssigned(cleanedLocations);

    console.log(
      `   ✅ Final assigned after adjustment: ${assignedAfter} (target: ${total})`
    );

    if (APPLY_CHANGES) {
      doc.locations = cleanedLocations;
      await doc.save();
    }
  }

  console.log("\n📊 Reconciliation complete.");
  console.log(`   Items checked:       ${checked}`);
  console.log(`   Items adjusted:      ${adjustedItems}`);
  console.log(`   Copies removed total: ${totalCopiesRemoved}`);
  console.log(
    `   Mode: ${APPLY_CHANGES ? "APPLY (changes saved)" : "DRY RUN (no writes)"}`
  );

  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected. Done.");
}

// Run
reconcileAssignedToTotal().catch((err) => {
  console.error("❌ Reconciliation failed:", err);
  mongoose.disconnect();
});
