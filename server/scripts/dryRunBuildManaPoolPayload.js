import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";

const MONGO_URI = process.env.MONGO_URI;
const LIMIT = 20;

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-ScryfallPayloadDryRun/1.0",
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

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const inventoryCollection = mongoose.connection.collection("inventoryitems");

  const items = await inventoryCollection
    .find({})
    .sort({ updatedAt: -1 })
    .limit(LIMIT)
    .toArray();

  console.log(`\n🔎 Building CORRECT Mana Pool Scryfall dry-run payload for ${items.length} inventoryItems...\n`);

  const payload = [];
  const skipped = [];

  for (const item of items) {
    const summary = summarizeItem(item);
    const quantity = getQuantity(item);
    const priceCents = getPriceCents(item);
    const finishId = getFinishId(item);
    const conditionId = getConditionId(item);

    console.log("========================================");
    console.log(`Card: ${summary}`);
    console.log(`Inventory ID: ${item._id}`);

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
      console.log(`❌ SKIP: ${issues.join(", ")}`);
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

      console.log("✅ READY FOR SCRYFALL PAYLOAD");
      console.log({
        scryfall_name: scryfallCard.name,
        set: scryfallCard.set,
        collector_number: scryfallCard.collector_number,
        condition_id: conditionId,
        finish_id: finishId,
      });
      console.log(JSON.stringify(payloadItem, null, 2));
    } catch (err) {
      console.log("❌ SKIP: Scryfall mapping failed");
      console.log({
        status: err.response?.status,
        data: err.response?.data,
        message: err.message,
      });

      skipped.push({
        id: item._id.toString(),
        summary,
        issues: [err.response?.data || err.message],
      });
    }

    await sleep(120);
  }

  console.log("\n========================================");
  console.log("DRY RUN SUMMARY");
  console.log("========================================");
  console.log(`Checked: ${items.length}`);
  console.log(`Ready payload items: ${payload.length}`);
  console.log(`Skipped: ${skipped.length}`);

  console.log("\nPayload that WOULD be sent to Mana Pool:");
  console.log(JSON.stringify(payload, null, 2));

  console.log("\nSkipped:");
  console.log(JSON.stringify(skipped, null, 2));

  console.log("\n⚠️ DRY RUN ONLY.");
  console.log("⚠️ Nothing was sent to Mana Pool.");
  console.log("⚠️ Nothing was changed in MongoDB.");

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from MongoDB");
}

main().catch(async (err) => {
  console.error("❌ Dry run failed:", err.response?.data || err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});