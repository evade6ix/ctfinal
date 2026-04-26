import "dotenv/config";
import mongoose from "mongoose";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";

const MAX_PAGES = 100;

const OPEN_STATES = new Set([
  "paid",
  "hub_pending",
  "pending",
  "confirmed",
  "processing"
]);

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function normCondition(c) {
  const v = norm(c);
  if (v === "near mint") return "nm";
  if (v === "lightly played") return "lp";
  if (v === "moderately played") return "mp";
  if (v === "heavily played") return "hp";
  if (v === "damaged") return "dmg";
  return v;
}

function extractIsFoil(a) {
  return (
    a?.isFoil === true ||
    a?.is_foil === true ||
    a?.foil === true ||
    a?.properties?.mtg_foil === true ||
    a?.properties?.foil === true ||
    String(a?.variant || "").toLowerCase().includes("foil") ||
    String(a?.name || "").toLowerCase().includes("foil") ||
    String(a?.description || "").toLowerCase().includes("foil")
  );
}

function extractCondition(a) {
  return (
    a?.condition ||
    a?.card_condition ||
    a?.attributes?.condition ||
    a?.properties?.condition ||
    a?.description ||
    null
  );
}

function locQty(item) {
  return (item.locations || []).reduce(
    (sum, l) => sum + Number(l.quantity || 0),
    0
  );
}

await mongoose.connect(process.env.MONGO_URI);

const client = ct();
const openOrders = [];

for (let page = 1; page <= MAX_PAGES; page++) {
  const res = await client.get("/orders", {
    params: {
      order_as: "seller",
      page,
      limit: 50,
      sort: "date.desc",
    },
  });

  const orders = Array.isArray(res.data) ? res.data : res.data?.data || [];
  if (!orders.length) break;

  for (const o of orders) {
    const state = norm(o.state || o.status);
    if (OPEN_STATES.has(state)) openOrders.push(o);
  }
}

console.log(`✅ Open orders found: ${openOrders.length}`);

let issueCount = 0;

for (const order of openOrders) {
  const orderRes = await client.get(`/orders/${order.id}`);
  const fullOrder = orderRes.data || {};

  let rawItems = [];
  if (Array.isArray(fullOrder.order_items)) rawItems = fullOrder.order_items;
  else if (Array.isArray(fullOrder.items)) rawItems = fullOrder.items;
  else if (fullOrder.order_items?.data) rawItems = fullOrder.order_items.data;
  else if (fullOrder.items?.data) rawItems = fullOrder.items.data;

  const orderIssues = [];

  for (const a of rawItems) {
    const soldId = Number(a.product_id);
    const name = a.name || "Unknown";
    const condition = normCondition(extractCondition(a));
    const isFoil = extractIsFoil(a);

    const exact = await InventoryItem.findOne({ cardTraderId: soldId }).lean();
    const exactQty = exact ? locQty(exact) : 0;

    if (exactQty > 0) continue;

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const candidates = await InventoryItem.find({
      name: new RegExp(`^${escapedName}$`, "i"),
      condition: new RegExp(`^${condition}$`, "i"),
      isFoil,
    }).lean();

    const stocked = [];

    for (const item of candidates) {
      const quantity = locQty(item);
      if (quantity <= 0) continue;

      stocked.push({
        cardTraderId: item.cardTraderId,
        name: item.name,
        setCode: item.setCode,
        condition: item.condition,
        isFoil: item.isFoil,
        totalQuantity: item.totalQuantity,
        locationQty: quantity,
        locations: item.locations || [],
      });
    }

    orderIssues.push({
      soldCardTraderId: soldId,
      name,
      condition,
      isFoil,
      setName: a.expansion || null,
      quantitySold: a.quantity || 0,
      exactExists: !!exact,
      exactTotalQuantity: exact?.totalQuantity ?? null,
      exactLocationQty: exactQty,
      fallbackMatches: stocked,
    });
  }

  if (orderIssues.length) {
    issueCount += orderIssues.length;

    console.log("\n==================================================");
    console.log("⚠️ ORDER HAS POSSIBLE UNASSIGNED LINES");
    console.log({
      orderId: order.id,
      orderCode: order.code || order.order_code || order.reference,
      state: order.state,
      issueLines: orderIssues.length,
    });

    console.log(JSON.stringify(orderIssues, null, 2));
  }
}

console.log("\nDONE");
console.log(`Open orders checked: ${openOrders.length}`);
console.log(`Possible unassigned lines found: ${issueCount}`);

await mongoose.disconnect();