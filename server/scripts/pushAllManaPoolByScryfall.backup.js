import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const LIVE_PUSH = process.env.LIVE_PUSH === "true";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
const BATCH_SIZE = process.env.BATCH_SIZE ? Number(process.env.BATCH_SIZE) : 500;

const SCRYFALL_DELAY_MS = process.env.SCRYFALL_DELAY_MS
  ? Number(process.env.SCRYFALL_DELAY_MS)
  : 500;

const BETWEEN_BATCH_DELAY_MS = process.env.BETWEEN_BATCH_DELAY_MS
  ? Number(process.env.BETWEEN_BATCH_DELAY_MS)
  : 1000;

const MAX_SCRYFALL_ATTEMPTS = process.env.MAX_SCRYFALL_ATTEMPTS
  ? Number(process.env.MAX_SCRYFALL_ATTEMPTS)
  : 6;

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-FullInventoryPush/1.0",
  },
});

const manaPoolApi = axios.create({
  baseURL: MANAPOOL_API_BASE_URL,
  timeout: 60000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-ManaPool-Email": MANAPOOL_EMAIL,
    "X-ManaPool-Access-Token": MANAPOOL_ACCESS_TOKEN,
  },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeItem(item) {
  return [
    item.name || "Unnamed",
    item.setCode ? `Set: ${item.setCode}` : null,
    item.condition || null,
    item.isFoil ? "Foil" : "Nonfoil",
  ]
    .filter(Boolean)
    .join(" | ");
}

function getQuantity(item) {
  if (typeof item.totalQuantity === "number") {
    return Math.max(0, item.totalQuantity);
  }

  if (Array.isArray(item.locations)) {
    return item.locations.reduce((sum, loc) => {
      const qty = typeof loc.quantity === "number" ? loc.quantity : 0;
      return sum + Math.max(0, qty);
    }, 0);
  }

  return 0;
}

function getPriceCents(item) {
  if (typeof item.priceCents === "number") return Math.round(item.priceCents);
  if (typeof item.price_cents === "number") return Math.round(item.price_cents);
  if (typeof item.price === "number") return Math.round(item.price * 100);
  return null;
}

function getFinishId(item) {
  if (item.isFoil === true) return "FO";
  return "NF";
}

function getConditionId(item) {
  const raw = String(item.condition || "").trim().toLowerCase();

  const map = {
    "near mint": "NM",
    nm: "NM",

    "lightly played": "LP",
    "slightly played": "LP",
    lp: "LP",
    sp: "LP",

    "moderately played": "MP",
    mp: "MP",

    "heavily played": "HP",
    hp: "HP",

    damaged: "DMG",
    dmg: "DMG",
  };

  return map[raw] || null;
}

function parseCustomExternalId(customExternalId) {
  const match = String(customExternalId || "").match(
    /^G3-INV-([a-f0-9]{24})-([A-Z]+)-([A-Z]+)$/i
  );

  if (!match) return null;

  return {
    inventoryItemId: match[1],
    conditionId: match[2],
    finishId: match[3],
  };
}

function getRetryAfterMs(err) {
  const retryAfterHeader = err.response?.headers?.["retry-after"];

  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return (retryAfterSeconds + 2) * 1000;
    }
  }

  return 65000;
}

async function findScryfallCard(item, cache) {
  const key = `${String(item.name || "").toLowerCase()}|${String(
    item.setCode || ""
  ).toLowerCase()}`;

  if (cache.has(key)) return cache.get(key);

  const params = {
    exact: item.name,
    set: item.setCode,
  };

  for (let attempt = 1; attempt <= MAX_SCRYFALL_ATTEMPTS; attempt++) {
    try {
      const res = await scryfallApi.get("/cards/named", { params });

      cache.set(key, res.data);
      return res.data;
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        const waitMs = getRetryAfterMs(err);

        console.warn(
          `⚠️ Scryfall rate limited on ${item.name} [${item.setCode}]. Waiting ${Math.round(
            waitMs / 1000
          )} seconds, attempt ${attempt}/${MAX_SCRYFALL_ATTEMPTS}...`
        );

        await sleep(waitMs);
        continue;
      }

      if (status >= 500 && attempt < MAX_SCRYFALL_ATTEMPTS) {
        const waitMs = 10000 * attempt;

        console.warn(
          `⚠️ Scryfall server error on ${item.name} [${item.setCode}]. Waiting ${Math.round(
            waitMs / 1000
          )} seconds, attempt ${attempt}/${MAX_SCRYFALL_ATTEMPTS}...`
        );

        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }

  throw new Error(
    `Scryfall lookup failed after ${MAX_SCRYFALL_ATTEMPTS} attempts for ${item.name} [${item.setCode}]`
  );
}

async function updateMongoWithManaPoolResults(inventoryCollection, inventoryRows) {
  let updated = 0;

  for (const inv of inventoryRows) {
    const parsed = parseCustomExternalId(inv.custom_external_id);

    if (!parsed) {
      console.warn("⚠️ Could not parse custom_external_id:", inv.custom_external_id);
      continue;
    }

    const single = inv.product?.single || {};

    await inventoryCollection.updateOne(
      { _id: new mongoose.Types.ObjectId(parsed.inventoryItemId) },
      {
        $set: {
          "identifiers.scryfallId": single.scryfall_id || null,
          "identifiers.mtgjsonUuid": single.mtgjson_id || null,
          "identifiers.tcgplayerProductId": single.tcgplayer_id || null,
          "identifiers.tcgplayerSkuId": inv.product?.tcgplayer_sku || null,

          "manapool.inventoryId": inv.id,
          "manapool.productId": inv.product_id || inv.product?.id || null,
          "manapool.productType": inv.product_type || "mtg_single",
          "manapool.tcgplayerSku": inv.product?.tcgplayer_sku || null,
          "manapool.scryfallId": single.scryfall_id || null,
          "manapool.languageId": single.language_id || "EN",
          "manapool.conditionId": single.condition_id || parsed.conditionId,
          "manapool.finishId": single.finish_id || parsed.finishId,
          "manapool.customExternalId": inv.custom_external_id,
          "manapool.lastSyncedAt": new Date(),
          "manapool.lastSyncedQuantity": inv.quantity,
          "manapool.lastSyncedPriceCents": inv.price_cents,
        },
      }
    );

    updated++;
  }

  return updated;
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing in .env");
    process.exit(1);
  }

  if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
    console.error("❌ MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN missing in .env");
    process.exit(1);
  }

  if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE <= 0 || BATCH_SIZE > 2000) {
    console.error("❌ BATCH_SIZE must be between 1 and 2000.");
    process.exit(1);
  }

  console.log("========================================");
  console.log("MANA POOL FULL INVENTORY PUSH");
  console.log("========================================");
  console.log(`Mode: ${LIVE_PUSH ? "LIVE PUSH" : "DRY RUN ONLY"}`);
  console.log(`Limit: ${LIMIT || "ALL"}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Scryfall delay: ${SCRYFALL_DELAY_MS}ms`);
  console.log(`Max Scryfall attempts: ${MAX_SCRYFALL_ATTEMPTS}`);
  console.log("");

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const inventoryCollection = mongoose.connection.collection("inventoryitems");

  let query = inventoryCollection.find({}).sort({ updatedAt: -1 });

  if (LIMIT > 0) {
    query = query.limit(LIMIT);
  }

  const items = await query.toArray();

  console.log(`Found ${items.length} inventoryItems to check.\n`);

  const scryfallCache = new Map();
  const payload = [];
  const skipped = [];

  let checked = 0;

  for (const item of items) {
    checked++;

    const summary = summarizeItem(item);
    const quantity = getQuantity(item);
    const priceCents = getPriceCents(item);
    const finishId = getFinishId(item);
    const conditionId = getConditionId(item);

    const issues = [];

    if (!item.name) issues.push("Missing name");
    if (!item.setCode) issues.push("Missing setCode");
    if (!conditionId) issues.push(`Could not map condition: ${item.condition}`);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      issues.push("Quantity is zero/invalid");
    }

    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      issues.push("Price is missing/invalid");
    }

    if (issues.length > 0) {
      skipped.push({
        id: item._id.toString(),
        summary,
        issues,
      });

      console.log(`❌ SKIP ${checked}/${items.length}: ${summary}`);
      console.log(`   ${issues.join(", ")}`);
      continue;
    }

    try {
      const scryfallCard = await findScryfallCard(item, scryfallCache);

      const payloadItem = {
        scryfall_id: scryfallCard.id,
        language_id: "EN",
        finish_id: finishId,
        condition_id: conditionId,
        price_cents: priceCents,
        quantity,
        custom_external_id: `G3-INV-${item._id.toString()}-${conditionId}-${finishId}`,
      };

      payload.push(payloadItem);

      console.log(
        `✅ READY ${checked}/${items.length}: ${summary} → ${conditionId}/${finishId}, qty ${quantity}, ${priceCents}c`
      );
    } catch (err) {
      skipped.push({
        id: item._id.toString(),
        summary,
        issues: [err.response?.data || err.message],
      });

      console.log(`❌ SKIP ${checked}/${items.length}: ${summary}`);
      console.log("   Scryfall mapping failed:", err.response?.data || err.message);
    }

    await sleep(SCRYFALL_DELAY_MS);
  }

  console.log("\n========================================");
  console.log("PRE-PUSH SUMMARY");
  console.log("========================================");
  console.log(`Checked: ${items.length}`);
  console.log(`Ready payload items: ${payload.length}`);
  console.log(`Skipped before push: ${skipped.length}`);

  if (skipped.length) {
    console.log("\nSkipped preview:");
    console.log(JSON.stringify(skipped.slice(0, 50), null, 2));
  }

  if (LIVE_PUSH && skipped.length > 0) {
    console.log("\n❌ LIVE PUSH ABORTED.");
    console.log("Some items were skipped before push, so nothing was sent to Mana Pool.");
    console.log("Fix the skipped items first, then rerun.");

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB");
    process.exit(1);
  }

  if (!LIVE_PUSH) {
    console.log("\n⚠️ DRY RUN ONLY.");
    console.log("Nothing was sent to Mana Pool.");
    console.log("Nothing was changed in MongoDB.");
    console.log("");
    console.log("To push live, run:");
    console.log("LIVE_PUSH=true node scripts/pushAllManaPoolByScryfall.js");

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB");
    return;
  }

  if (payload.length === 0) {
    console.log("❌ Nothing to push.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\n⚠️ LIVE PUSH STARTING...");
  console.log(`Sending ${payload.length} items to Mana Pool.`);

  const chunks = chunkArray(payload, BATCH_SIZE);

  let totalInventoryRows = 0;
  let totalSkippedByManaPool = 0;
  let mongoUpdated = 0;
  const manaPoolSkipped = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    console.log(`\nSending batch ${i + 1}/${chunks.length} (${chunk.length} items)...`);

    const response = await manaPoolApi.post("/seller/inventory/scryfall_id", chunk);

    const inventoryRows = response.data?.inventory || [];
    const skippedRows = response.data?.skipped || [];

    totalInventoryRows += inventoryRows.length;
    totalSkippedByManaPool += skippedRows.length;
    manaPoolSkipped.push(...skippedRows);

    const updatedThisBatch = await updateMongoWithManaPoolResults(
      inventoryCollection,
      inventoryRows
    );

    mongoUpdated += updatedThisBatch;

    console.log(`✅ Batch ${i + 1} complete`);
    console.log(`   Mana Pool inventory rows: ${inventoryRows.length}`);
    console.log(`   Mana Pool skipped: ${skippedRows.length}`);
    console.log(`   Mongo inventoryItems updated: ${updatedThisBatch}`);

    await sleep(BETWEEN_BATCH_DELAY_MS);
  }

  console.log("\n========================================");
  console.log("LIVE PUSH COMPLETE");
  console.log("========================================");
  console.log(`Payload sent: ${payload.length}`);
  console.log(`Mana Pool inventory rows returned: ${totalInventoryRows}`);
  console.log(`Mana Pool skipped: ${totalSkippedByManaPool}`);
  console.log(`Mongo inventoryItems updated with manapool fields: ${mongoUpdated}`);
  console.log(`Pre-push skipped: ${skipped.length}`);

  if (manaPoolSkipped.length) {
    console.log("\nMana Pool skipped rows:");
    console.log(JSON.stringify(manaPoolSkipped, null, 2));
  }

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from MongoDB");
}

main().catch(async (err) => {
  console.error("❌ Full push failed:");
  console.error({
    status: err.response?.status,
    data: err.response?.data,
    message: err.message,
  });

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
