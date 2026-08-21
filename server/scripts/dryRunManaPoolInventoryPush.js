import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
const LIMIT = 20;

function getTcgplayerSkuId(item) {
  return (
    item?.identifiers?.tcgplayerSkuId ||
    item?.identifiers?.tcgplayer_sku_id ||
    item?.tcgplayerSkuId ||
    item?.tcgplayerSku ||
    item?.tcgplayer_sku ||
    item?.tcgplayer_sku_id ||
    item?.manaPool?.tcgplayerSkuId ||
    item?.marketplaceListings?.find?.((l) => l.channel === "manapool")
      ?.tcgplayerSkuId ||
    null
  );
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
  if (typeof item.priceCents === "number") {
    return Math.round(item.priceCents);
  }

  if (typeof item.price_cents === "number") {
    return Math.round(item.price_cents);
  }

  if (typeof item.price === "number") {
    return Math.round(item.price * 100);
  }

  return null;
}

function getCustomExternalId(item) {
  return `G3-INV-${item._id.toString()}`;
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

  console.log(`\n🔎 Dry-running first ${items.length} inventoryItems...\n`);

  const readyPayload = [];
  const skipped = [];

  for (const item of items) {
    const tcgplayerSku = getTcgplayerSkuId(item);
    const quantity = getQuantity(item);
    const priceCents = getPriceCents(item);
    const customExternalId = getCustomExternalId(item);

    const issues = [];

    if (!tcgplayerSku) {
      issues.push("Missing TCGPlayer SKU");
    }

    if (!Number.isInteger(Number(tcgplayerSku))) {
      issues.push("TCGPlayer SKU is not a number/integer");
    }

    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      issues.push("Missing or invalid price_cents");
    }

    if (!Number.isInteger(quantity) || quantity < 0) {
      issues.push("Missing or invalid quantity");
    }

    const summary = summarizeItem(item);

    if (issues.length > 0) {
      skipped.push({
        inventoryItemId: item._id.toString(),
        summary,
        issues,
        detected: {
          tcgplayerSku,
          quantity,
          priceCents,
          customExternalId,
        },
      });

      console.log(`❌ SKIP: ${summary}`);
      console.log(`   ID: ${item._id}`);
      console.log(`   Issues: ${issues.join(", ")}`);
      console.log("");
      continue;
    }

    const payloadItem = {
      tcgplayer_sku: Number(tcgplayerSku),
      price_cents: priceCents,
      quantity,
      custom_external_id: customExternalId,
    };

    readyPayload.push(payloadItem);

    console.log(`✅ READY: ${summary}`);
    console.log(`   ID: ${item._id}`);
    console.log(`   Payload: ${JSON.stringify(payloadItem)}`);
    console.log("");
  }

  console.log("========================================");
  console.log("DRY RUN SUMMARY");
  console.log("========================================");
  console.log(`Checked: ${items.length}`);
  console.log(`Ready to push: ${readyPayload.length}`);
  console.log(`Skipped: ${skipped.length}`);

  console.log("\nPayload preview:");
  console.log(JSON.stringify(readyPayload, null, 2));

  console.log("\n⚠️ Dry run only. Nothing was sent to Mana Pool.");
  console.log("⚠️ Nothing was changed in MongoDB.");

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from MongoDB");
}

main().catch(async (err) => {
  console.error("❌ Dry run failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});