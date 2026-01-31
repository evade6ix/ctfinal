// server/scripts/raiseFloorPrice.js
import "dotenv/config";
import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { ct } from "../ctClient.js";

const MIN_PRICE = 0.05;
const DRY_RUN = false; // set to true to test without updating CT or Mongo

async function run() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Mongo connected.");

    const client = ct();

    console.log(`🔎 Finding items priced below ${MIN_PRICE}...`);
    const lowItems = await InventoryItem.find({ price: { $lt: MIN_PRICE } });

    console.log(`➡️ ${lowItems.length} items found below ${MIN_PRICE}.`);

    let updatedCount = 0;
    let skippedNotFound = 0;
    let otherErrors = 0;

    for (const item of lowItems) {
      if (!item.cardTraderId) {
        console.warn(
          `⚠️ Skipping ${item.name} (${item._id}) — no cardTraderId on record.`
        );
        continue;
      }

      const newPriceCents = Math.round(MIN_PRICE * 100);

      console.log(
        `→ ${item.name} (CT #${item.cardTraderId}) from ${item.price} → ${MIN_PRICE}`
      );

      try {
        if (!DRY_RUN) {
          // 1) Update CardTrader listing
          await client.put(`/products/${item.cardTraderId}`, {
            price_cents: newPriceCents,
          });

          // 2) Update local Mongo mirror
          await InventoryItem.updateOne(
            { _id: item._id },
            { $set: { price: MIN_PRICE } }
          );
        }

        updatedCount += 1;
      } catch (err) {
        const status = err?.response?.status;

        if (status === 404) {
          console.warn(
            `❌ CT 404 for product ${item.cardTraderId} (${item.name}) — skipping.`
          );
          skippedNotFound += 1;

          // OPTIONAL: if you want to mark these as missing in Mongo, uncomment:
          // await InventoryItem.updateOne(
          //   { _id: item._id },
          //   { $set: { missingOnCardTrader: true } }
          // );

          continue;
        }

        console.error(
          `❌ Error updating ${item.name} (CT #${item.cardTraderId}):`,
          err.message || err
        );
        otherErrors += 1;
      }
    }

    console.log("🎉 Finished processing floor-price updates.");
    console.log(`   ✅ Updated: ${updatedCount}`);
    console.log(`   ⚠️ Skipped (404/not found): ${skippedNotFound}`);
    console.log(`   ❗ Other errors: ${otherErrors}`);
  } catch (err) {
    console.error("🚨 Fatal script error:", err);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Mongo disconnected.");
  }
}

run();
