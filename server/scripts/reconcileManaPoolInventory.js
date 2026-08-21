import "dotenv/config";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const MONGO_URI = process.env.MONGO_URI;
const LIVE_PUSH = process.env.LIVE_PUSH === "true";
const BATCH_SIZE = Math.max(1, Number(process.env.RECONCILE_BATCH_SIZE || 250));

function isMagicItem(item) {
  const game = String(item?.game || "").trim().toLowerCase();
  return !game || game === "1" || game === "magic" || game === "mtg";
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is missing");

  console.log("========================================");
  console.log("MANA POOL INVENTORY RECONCILIATION");
  console.log("========================================");
  console.log(`Mode: ${LIVE_PUSH ? "LIVE" : "DRY RUN"}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  await mongoose.connect(MONGO_URI);

  const allItems = await InventoryItem.find({}).sort({ updatedAt: -1 }).lean();
  const magicItems = allItems.filter(isMagicItem);

  console.log(`Loaded ${allItems.length} total inventory rows.`);
  console.log(`Reconciling ${magicItems.length} Magic inventory rows.`);
  console.log("Bin, row, locations, and totalQuantity are never modified by this script.\n");

  const batches = chunk(magicItems, BATCH_SIZE);
  const totals = {
    attempted: 0,
    payloadCount: 0,
    synced: 0,
    mongoUpdated: 0,
    skippedBeforePush: 0,
    skippedByManaPool: 0,
    errors: 0,
  };

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    console.log(`Batch ${index + 1}/${batches.length}: ${batch.length} rows`);

    try {
      const result = await syncInventoryItemsToManaPool(batch, { livePush: LIVE_PUSH });

      totals.attempted += result.attempted || 0;
      totals.payloadCount += result.payloadCount || 0;
      totals.synced += result.synced || 0;
      totals.mongoUpdated += result.mongoUpdated || 0;
      totals.skippedBeforePush += result.skippedBeforePush?.length || 0;
      totals.skippedByManaPool += result.skippedByManaPool?.length || 0;

      for (const group of result.aggregatedGroups || []) {
        console.log(
          `  ${group.scryfallId} ${group.conditionId}/${group.finishId}: ` +
            `${group.quantity} copies across ${group.memberCount} row(s)`
        );
      }

      if (result.skippedBeforePush?.length) {
        console.warn("  Skipped before push:", result.skippedBeforePush);
      }
      if (result.skippedByManaPool?.length) {
        console.warn("  Skipped by ManaPool:", result.skippedByManaPool);
      }
    } catch (error) {
      totals.errors += 1;
      console.error(`Batch ${index + 1} failed:`, error.response?.data || error.message);
    }
  }

  console.log("\n========================================");
  console.log("RECONCILIATION COMPLETE");
  console.log("========================================");
  console.table(totals);

  if (!LIVE_PUSH) {
    console.log("Dry run only. Run again with LIVE_PUSH=true to update ManaPool.");
  }

  if (totals.errors > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Fatal reconciliation error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
