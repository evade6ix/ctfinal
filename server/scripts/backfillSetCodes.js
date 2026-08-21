import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

// Simple sleep helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch expansion code (setCode) for a given blueprintId
 * using CardTrader marketplace products API:
 * GET /marketplace/products?blueprint_id=...
 *
 * We read expansion.code from the first product found.
 *
 * Includes basic retry with backoff on 429 (rate limit).
 */
async function fetchSetCodeForBlueprint(client, blueprintId, attempt = 1) {
  const MAX_ATTEMPTS = 5;

  try {
    const res = await client.get("/marketplace/products", {
      params: { blueprint_id: blueprintId }
    });

    const data = res.data;
    if (!data || typeof data !== "object") {
      console.warn(`⚠️ Unexpected response for blueprintId ${blueprintId}`);
      return null;
    }

    const keys = Object.keys(data);
    if (!keys.length) {
      // No products for this blueprint
      return null;
    }

    const firstKey = keys[0];
    const arr = data[firstKey];

    if (
      Array.isArray(arr) &&
      arr.length > 0 &&
      arr[0].expansion &&
      typeof arr[0].expansion.code === "string"
    ) {
      return arr[0].expansion.code;
    }

    return null;
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data || err.message;

    // Handle rate limiting with backoff
    if (status === 429 && attempt < MAX_ATTEMPTS) {
      const delay = 6000 * attempt; // 6s, 12s, 18s, ...
      console.warn(
        `⏳ 429 Too Many Requests for blueprintId ${blueprintId}. ` +
          `Attempt ${attempt}/${MAX_ATTEMPTS}. Waiting ${delay} ms before retry…`
      );
      await sleep(delay);
      return fetchSetCodeForBlueprint(client, blueprintId, attempt + 1);
    }

    console.error(
      `❌ Error fetching setCode for blueprintId ${blueprintId} (status ${status || "?"}):`,
      msg
    );
    return null;
  }
}

async function main() {
  console.log("🔌 Connecting to Mongo…");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to Mongo");

  // 1) Find all items missing setCode but having a blueprintId
  const itemsNeedingSet = await InventoryItem.find({
    setCode: { $in: [null, ""] },
    blueprintId: { $ne: null }
  }).lean();

  if (!itemsNeedingSet.length) {
    console.log("✅ No InventoryItems need setCode backfill.");
    await mongoose.disconnect();
    console.log("🔌 Mongo disconnected.");
    return;
  }

  console.log(
    `🔍 Found ${itemsNeedingSet.length} inventory items missing setCode.`
  );

  // 2) Unique blueprintIds
  const blueprintIds = [
    ...new Set(itemsNeedingSet.map((i) => i.blueprintId))
  ];
  console.log(
    `🧩 Unique blueprintIds needing setCode: ${blueprintIds.length}`
  );

  const client = ct();
  const blueprintToSetCode = new Map();

  // 3) Fetch setCode for each blueprintId with LIMITED CONCURRENCY
  // Keep concurrency low to respect rate limits
  const CONCURRENCY = 3;

  let currentIndex = 0;

  async function worker(workerId) {
    while (true) {
      const myIndex = currentIndex++;
      if (myIndex >= blueprintIds.length) break;

      const blueprintId = blueprintIds[myIndex];
      if (!blueprintId) continue;

      console.log(
        `[#${workerId}] → Fetching setCode for blueprintId ${blueprintId} (${myIndex + 1}/${blueprintIds.length})…`
      );

      const code = await fetchSetCodeForBlueprint(client, blueprintId);

      if (code) {
        console.log(
          `[#${workerId}] ✅ blueprintId ${blueprintId} → setCode "${code}"`
        );
        blueprintToSetCode.set(blueprintId, code);
      } else {
        console.log(
          `[#${workerId}] ⚠️ No setCode found for blueprintId ${blueprintId}`
        );
      }

      // Small delay between requests to smooth things out
      await sleep(150);
    }
  }

  // Spin up N workers
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  if (!blueprintToSetCode.size) {
    console.log(
      "⚠️ No setCodes were resolved from CardTrader. Nothing to update."
    );
    await mongoose.disconnect();
    console.log("🔌 Mongo disconnected.");
    return;
  }

  // 4) Apply updates to InventoryItem documents
  let updatedCount = 0;

  for (const item of itemsNeedingSet) {
    const code = blueprintToSetCode.get(item.blueprintId);
    if (!code) continue;

    const res = await InventoryItem.updateOne(
      { _id: item._id },
      { $set: { setCode: code } }
    );

    if (res.modifiedCount > 0) {
      updatedCount++;
    }
  }

  console.log(
    `🎉 Backfill complete. Updated setCode for ${updatedCount} inventory items.`
  );

  await mongoose.disconnect();
  console.log("🔌 Mongo disconnected.");
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err?.response?.data || err.message);
  mongoose
    .disconnect()
    .finally(() => process.exit(1));
});
