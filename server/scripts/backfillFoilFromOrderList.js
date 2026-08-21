// server/scripts/backfillFoilFromOrderList.js
import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const DRY_RUN = false; // change to false when ready to write

await mongoose.connect(process.env.MONGO_URI);
const client = ct();

console.log(DRY_RUN ? "DRY RUN MODE — no DB writes" : "LIVE MODE — updating DB");
console.log("Loading existing allocations...");

const allocations = await OrderAllocation.find({})
  .select("orderId cardTraderId name condition isFoil")
  .lean();

const wantedKeys = new Set(
  allocations.map((a) => `${String(a.orderId)}|${Number(a.cardTraderId)}`)
);

console.log(`Loaded ${allocations.length} allocations`);
console.log("Fetching current open CardTrader Zero orders once...");

const ctItemMap = new Map();

let page = 1;
const limit = 100;

while (true) {
  const r = await client.get("/orders", {
    params: {
      order_as: "seller",
      sort: "date.desc",
      page,
      limit,
    },
  });

  const orders = Array.isArray(r.data) ? r.data : [];
  console.log(`Page ${page}: ${orders.length} orders`);

  if (!orders.length) break;

  for (const order of orders) {
    const orderId = String(order.id);
    const state = String(order.state || "").toLowerCase();
    const isZero = order.via_cardtrader_zero === true;

    // Only current open Zero orders
    if (!isZero || state !== "hub_pending") {
      continue;
    }

    const items = Array.isArray(order.order_items) ? order.order_items : [];

    for (const item of items) {
      const productId = Number(item.product_id);
      if (!productId) continue;

      const key = `${orderId}|${productId}`;
      if (!wantedKeys.has(key)) continue;

      ctItemMap.set(key, {
        orderId,
        cardTraderId: productId,
        name: item.name || null,
        condition: item.properties?.condition || null,
        isFoil: item.properties?.mtg_foil === true,
      });
    }
  }

  if (orders.length < limit) break;
  page++;
}

console.log(`\nMatched current Zero CT items found: ${ctItemMap.size}`);

let matched = 0;
let missing = 0;
let changed = 0;

for (const alloc of allocations) {
  const key = `${String(alloc.orderId)}|${Number(alloc.cardTraderId)}`;
  const ctItem = ctItemMap.get(key);

  if (!ctItem) {
    missing++;
    continue;
  }

  matched++;

  const changes = [];

  if (alloc.name !== ctItem.name) {
    changes.push(`name: ${alloc.name || "null"} → ${ctItem.name || "null"}`);
  }

  if (alloc.condition !== ctItem.condition) {
    changes.push(
      `condition: ${alloc.condition || "null"} → ${ctItem.condition || "null"}`
    );
  }

  if (alloc.isFoil !== ctItem.isFoil) {
    changes.push(`isFoil: ${alloc.isFoil} → ${ctItem.isFoil}`);
  }

  if (changes.length > 0) {
    changed++;

    if (DRY_RUN) {
      console.log(
        `DRY CHANGE → ${ctItem.orderId} | ${ctItem.cardTraderId} | ${
          ctItem.name
        } | ${ctItem.isFoil ? "Foil" : "Non-Foil"} | ${
          ctItem.condition || "-"
        }`
      );
      console.log(`  ${changes.join(" | ")}`);
    } else {
      await OrderAllocation.updateOne(
        {
          orderId: ctItem.orderId,
          cardTraderId: ctItem.cardTraderId,
        },
        {
          $set: {
            name: ctItem.name,
            condition: ctItem.condition,
            isFoil: ctItem.isFoil,
          },
        }
      );

      console.log(
        `UPDATED → ${ctItem.orderId} | ${ctItem.cardTraderId} | ${
          ctItem.name
        } | ${ctItem.isFoil ? "Foil" : "Non-Foil"} | ${
          ctItem.condition || "-"
        }`
      );
    }
  }
}

console.log(DRY_RUN ? "\nDRY RUN DONE — no database writes made" : "\nLIVE UPDATE DONE");
console.log({
  allocations: allocations.length,
  matched,
  missing,
  [DRY_RUN ? "wouldChange" : "updated"]: changed,
});

await mongoose.disconnect();