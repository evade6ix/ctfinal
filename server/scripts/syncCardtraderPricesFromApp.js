import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
const CARDTRADER_TOKEN =
  process.env.CARDTRADER_API_TOKEN ||
  process.env.CARDTRADER_TOKEN ||
  process.env.CT_TOKEN;

const CARDTRADER_BASE = "https://api.cardtrader.com/api/v2";
const COLLECTION_NAME = "inventoryitems";

const CHUNK_SIZE = 250;
const ONLY_CHANGED = true;
const SKIP_ZERO_QTY = false;
const JOB_POLL_MS = 2000;
const AFTER_SUBMIT_WAIT_MS = 1500;

function toMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRemotePrice(product) {
  const cents = product?.price_cents ?? product?.price?.cents ?? null;
  if (cents !== null && Number.isFinite(Number(cents))) {
    return Number(cents) / 100;
  }

  const raw = product?.price ?? null;
  if (raw !== null && Number.isFinite(Number(raw))) {
    return Number(raw);
  }

  return null;
}

function flattenExport(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.products)) return payload.products;
  if (Array.isArray(payload?.resource)) return payload.resource;
  if (Array.isArray(payload?.resources)) return payload.resources;
  return [];
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function fetchMyProductsExport() {
  const res = await fetch(`${CARDTRADER_BASE}/products/export`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CARDTRADER_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CardTrader export failed: ${res.status} ${text}`);
  }

  return await res.json();
}

async function bulkUpdatePrices(products) {
  const res = await fetch(`${CARDTRADER_BASE}/products/bulk_update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CARDTRADER_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ products }),
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`bulk_update failed: ${res.status} ${raw}`);
  }

  const json = JSON.parse(raw);
  if (!json?.job) {
    throw new Error(`bulk_update did not return job UUID: ${raw}`);
  }

  return json.job;
}

async function fetchJob(uuid) {
  const res = await fetch(`${CARDTRADER_BASE}/jobs/${uuid}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CARDTRADER_TOKEN}`,
      Accept: "application/json",
    },
  });

  const raw = await res.text();

  if (res.status === 429) {
    const err = new Error(`job ${uuid} rate limited: ${raw}`);
    err.isRateLimit = true;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`job ${uuid} failed: ${res.status} ${raw}`);
  }

  return JSON.parse(raw);
}

async function waitForJob(uuid, chunkIndex, chunkCount) {
  await sleep(AFTER_SUBMIT_WAIT_MS);

  while (true) {
    try {
      const job = await fetchJob(uuid);
      const stats = job?.stats || {};
      const state = job?.state || "unknown";

      console.log(
        `🧾 Job ${chunkIndex}/${chunkCount} | ${uuid} | state=${state} | ok=${stats.ok ?? 0} | warning=${stats.warning ?? 0} | error=${stats.error ?? 0}`
      );

      if (state === "completed") return job;
      if (state === "unprocessable") {
        throw new Error(`Job ${uuid} became unprocessable`);
      }

      await sleep(JOB_POLL_MS);
    } catch (err) {
      if (err.isRateLimit) {
        console.log(`⏳ Job ${chunkIndex}/${chunkCount} rate limited, backing off...`);
        await sleep(2500);
        continue;
      }
      throw err;
    }
  }
}

async function run() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI");
    process.exit(1);
  }

  if (!CARDTRADER_TOKEN) {
    console.error("❌ Missing CARDTRADER_API_TOKEN / CARDTRADER_TOKEN / CT_TOKEN");
    process.exit(1);
  }

  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  console.log(`📦 Using collection: ${COLLECTION_NAME}`);

  console.log("⬇️ Fetching app inventory...");
  const localItems = await collection
    .find({
      cardTraderId: { $exists: true, $ne: null },
      price: { $exists: true, $ne: null },
    })
    .toArray();

  console.log(`📋 Local inventory rows: ${localItems.length}`);

  console.log("⬇️ Fetching live CardTrader product export...");
  const exportPayload = await fetchMyProductsExport();
  const remoteProducts = flattenExport(exportPayload);
  console.log(`📋 Live CardTrader products: ${remoteProducts.length}`);

  if (!remoteProducts.length) {
    throw new Error("No remote products found in CardTrader export");
  }

  const remoteById = new Map(remoteProducts.map((p) => [String(p.id), p]));

  let scanned = 0;
  let matched = 0;
  let unchanged = 0;
  let skipped = 0;
  let missingRemote = 0;
  let queued = 0;

  const updates = [];

  console.log("\n🧠 Building bulk update payload...\n");

  for (const item of localItems) {
    scanned += 1;

    const name = item.name || "Unnamed Item";
    const productId = String(item.cardTraderId);
    const localPrice = Number(item.price);
    const remote = remoteById.get(productId);

    if (!remote) {
      missingRemote += 1;
      console.log(
        `[${scanned}/${localItems.length}] ⚠️ Missing remote listing | ${name} | CT ${productId}`
      );
      continue;
    }

    matched += 1;

    const remotePrice = extractRemotePrice(remote);
    const remoteQty = Number(remote.quantity ?? 0);

    if (!Number.isFinite(localPrice)) {
      skipped += 1;
      console.log(
        `[${scanned}/${localItems.length}] ⏭️ Invalid local price | ${name} | local=${item.price}`
      );
      continue;
    }

    if (SKIP_ZERO_QTY && remoteQty <= 0) {
      skipped += 1;
      console.log(
        `[${scanned}/${localItems.length}] ⏭️ Zero qty skipped | ${name} | CT ${productId}`
      );
      continue;
    }

    if (
      ONLY_CHANGED &&
      remotePrice !== null &&
      Math.abs(localPrice - remotePrice) < 0.000001
    ) {
      unchanged += 1;
      continue;
    }

    updates.push({
      id: Number(productId),
      price: Number(localPrice),
    });

    queued += 1;

    console.log(
      `[${scanned}/${localItems.length}] 📝 Queued | ${name} | CT ${productId} | ${toMoney(remotePrice)} -> ${toMoney(localPrice)} | qty=${remoteQty}`
    );
  }

  console.log("\n==================================================");
  console.log("📦 BULK UPDATE PLAN");
  console.log("==================================================");
  console.log(`Scanned:         ${scanned}`);
  console.log(`Matched:         ${matched}`);
  console.log(`Queued:          ${queued}`);
  console.log(`Unchanged:       ${unchanged}`);
  console.log(`Skipped:         ${skipped}`);
  console.log(`Missing Remote:  ${missingRemote}`);
  console.log("==================================================");

  if (!updates.length) {
    console.log("✅ Nothing to update.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const chunks = chunkArray(updates, CHUNK_SIZE);

  console.log(`\n🚀 Sending ${updates.length} updates in ${chunks.length} bulk job(s)...\n`);

  let submitted = 0;
  let jobsCompleted = 0;
  let okTotal = 0;
  let warningTotal = 0;
  let errorTotal = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkIndex = i + 1;

    console.log(
      `📤 Submitting chunk ${chunkIndex}/${chunks.length} | ${chunk.length} product(s)`
    );

    const jobUuid = await bulkUpdatePrices(chunk);
    submitted += chunk.length;

    console.log(
      `✅ Submitted chunk ${chunkIndex}/${chunks.length} | job=${jobUuid}`
    );

    const job = await waitForJob(jobUuid, chunkIndex, chunks.length);
    const stats = job?.stats || {};

    jobsCompleted += 1;
    okTotal += Number(stats.ok || 0);
    warningTotal += Number(stats.warning || 0);
    errorTotal += Number(stats.error || 0);

    console.log(
      `📊 Chunk ${chunkIndex}/${chunks.length} complete | ok=${stats.ok ?? 0} | warning=${stats.warning ?? 0} | error=${stats.error ?? 0}\n`
    );
  }

  console.log("==================================================");
  console.log("🏁 BULK PRICE SYNC COMPLETE");
  console.log("==================================================");
  console.log(`Queued Updates:  ${queued}`);
  console.log(`Submitted:       ${submitted}`);
  console.log(`Jobs Completed:  ${jobsCompleted}/${chunks.length}`);
  console.log(`Job OK:          ${okTotal}`);
  console.log(`Job Warnings:    ${warningTotal}`);
  console.log(`Job Errors:      ${errorTotal}`);
  console.log("==================================================");

  await mongoose.disconnect();
  console.log("✅ MongoDB disconnected");
  process.exit(0);
}

run().catch(async (err) => {
  console.error("\n❌ Fatal error:", err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});