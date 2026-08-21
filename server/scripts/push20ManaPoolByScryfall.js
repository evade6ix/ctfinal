import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const LIMIT = 20;

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-LivePush20/1.0",
  },
});

const manaPoolApi = axios.create({
  baseURL: MANAPOOL_API_BASE_URL,
  timeout: 30000,
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

async function findScryfallCard(item) {
  const res = await scryfallApi.get("/cards/named", {
    params: {
      exact: item.name,
      set: item.setCode,
    },
  });

  return res.data;
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

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const inventoryCollection = mongoose.connection.collection("inventoryitems");

  const items = await inventoryCollection
    .find({})
    .sort({ updatedAt: -1 })
    .limit(LIMIT)
    .toArray();

  console.log(`\n⚠️ LIVE PUSH: Building Mana Pool payload for ${items.length} inventoryItems...\n`);

  const payload = [];
  const skipped = [];

  for (const item of items) {
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
      console.log(`❌ SKIP: ${summary}`);
      console.log(`   Issues: ${issues.join(", ")}`);
      skipped.push({ id: item._id.toString(), summary, issues });
      continue;
    }

    try {
      const scryfallCard = await findScryfallCard(item);

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

      console.log(`✅ READY: ${summary}`);
      console.log(
        `   ${scryfallCard.name} [${scryfallCard.set.toUpperCase()} #${scryfallCard.collector_number}] ${conditionId}/${finishId} qty ${quantity} price ${priceCents}c`
      );
    } catch (err) {
      console.log(`❌ SKIP: ${summary}`);
      console.log("   Scryfall mapping failed:", err.response?.data || err.message);

      skipped.push({
        id: item._id.toString(),
        summary,
        issues: [err.response?.data || err.message],
      });
    }

    await sleep(120);
  }

  console.log("\n========================================");
  console.log("LIVE PUSH PREVIEW");
  console.log("========================================");
  console.log(`Checked: ${items.length}`);
  console.log(`Payload items ready: ${payload.length}`);
  console.log(`Skipped before push: ${skipped.length}`);

  if (payload.length === 0) {
    console.log("❌ Nothing to push.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\nPayload being sent:");
  console.log(JSON.stringify(payload, null, 2));

  console.log("\n⚠️ Sending payload to Mana Pool now...");

  const response = await manaPoolApi.post("/seller/inventory/scryfall_id", payload);

  console.log("\n✅ Mana Pool response:");
  console.log(JSON.stringify(response.data, null, 2));

  console.log("\n========================================");
  console.log("LIVE PUSH SUMMARY");
  console.log("========================================");
  console.log(`Sent payload items: ${payload.length}`);
  console.log(`Mana Pool created/updated: ${response.data?.inventory?.length ?? 0}`);
  console.log(`Mana Pool skipped: ${response.data?.skipped?.length ?? 0}`);

  if (response.data?.skipped?.length) {
    console.log("\nSkipped by Mana Pool:");
    console.log(JSON.stringify(response.data.skipped, null, 2));
  }

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from MongoDB");
}

main().catch(async (err) => {
  console.error("❌ Live push failed:");
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