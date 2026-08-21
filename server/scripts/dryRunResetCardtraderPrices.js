import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
const CARDTRADER_TOKEN =
  process.env.CARDTRADER_API_TOKEN ||
  process.env.CARDTRADER_TOKEN ||
  process.env.CT_TOKEN;

const CARDTRADER_BASE = "https://api.cardtrader.com/api/v2";
const COLLECTION_NAME = "inventoryitems";

// Safety options
const ONLY_CHANGED = true;        // only send updates when price differs
const SKIP_ZERO_QTY = false;      // set true if you want to skip listings with 0 qty
const DELAY_MS = 75;              // small delay between writes to be gentle
const LOG_EVERY = 25;             // progress heartbeat

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

async function updateCardtraderPrice(productId, newPrice) {
  const cents = Math.round(Number(newPrice) * 100);

  const res = await fetch(`${CARDTRADER_BASE}/products/${productId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CARDTRADER_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_cents: cents,
    }),
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`PUT ${productId} failed: ${res.status} ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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

  const remoteById = new Map(
    remoteProducts.map((p) => [String(p.id), p])
  );

  let scanned = 0;
  let matched = 0;
  let unchanged = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let missingRemote = 0;

  console.log("\n🚀 Starting live price sync...\n");

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
      if (scanned % LOG_EVERY === 0) {
        console.log(
          `[${scanned}/${localItems.length}] ✅ No change needed so far | Updated=${updated} | Unchanged=${unchanged} | Failed=${failed}`
        );
      }
      continue;
    }

    try {
      console.log(
        `[${scanned}/${localItems.length}] 💸 Updating | ${name} | CT ${productId} | ${toMoney(remotePrice)} -> ${toMoney(localPrice)} | qty=${remoteQty}`
      );

      await updateCardtraderPrice(productId, localPrice);
      updated += 1;

      console.log(
        `[${scanned}/${localItems.length}] ✅ Updated | ${name} | CT ${productId}`
      );

      if (DELAY_MS > 0) {
        await sleep(DELAY_MS);
      }
    } catch (err) {
      failed += 1;
      console.log(
        `[${scanned}/${localItems.length}] ❌ Failed | ${name} | CT ${productId} | ${err.message}`
      );
    }

    if (scanned % LOG_EVERY === 0) {
      console.log(
        `\n📊 Progress checkpoint: ${scanned}/${localItems.length} scanned | matched=${matched} | updated=${updated} | unchanged=${unchanged} | skipped=${skipped} | missingRemote=${missingRemote} | failed=${failed}\n`
      );
    }
  }

  console.log("\n==================================================");
  console.log("🏁 LIVE PRICE SYNC COMPLETE");
  console.log("==================================================");
  console.log(`Scanned:         ${scanned}`);
  console.log(`Matched:         ${matched}`);
  console.log(`Updated:         ${updated}`);
  console.log(`Unchanged:       ${unchanged}`);
  console.log(`Skipped:         ${skipped}`);
  console.log(`Missing Remote:  ${missingRemote}`);
  console.log(`Failed:          ${failed}`);
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