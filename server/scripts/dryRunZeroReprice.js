import "dotenv/config";
import mongoose from "mongoose";

const API = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

await mongoose.connect(process.env.MONGO_URI);

const inventory = await mongoose.connection.db
  .collection("inventoryitems")
  .find({})
  .limit(200)
  .toArray();

// ---- get your CT products (mapping id -> blueprint_id + properties)
const res = await fetch(`${API}/products/export`, {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
  },
});

const ctProducts = await res.json();

// map for fast lookup
const ctMap = new Map();
for (const p of ctProducts) {
  ctMap.set(p.id, p);
}

// ---- helpers
function normalizeCondition(c) {
  if (!c) return "";
  if (c === "NM") return "Near Mint";
  return c;
}

function centsToFloat(c) {
  return (c || 0) / 100;
}

function floatToCents(f) {
  return Math.round(f * 100);
}

function clamp(price) {
  return Math.max(0.02, Math.round(price * 100) / 100);
}

// ---- main
let nonFoilResults = [];
let foilResults = [];

for (const item of inventory) {
  const ct = ctMap.get(item.cardTraderId);
  if (!ct) continue;

  const isFoil = ct.properties_hash?.mtg_foil === true;

  // collect foil samples (skip pricing)
  if (isFoil && foilResults.length < 5) {
    foilResults.push({
      name: item.name,
      current: item.price,
      foil: true,
      skipped: true,
    });
    continue;
  }

  if (isFoil) continue;

  if (nonFoilResults.length >= 5) continue;

  const blueprintId = ct.blueprint_id;
  const language = ct.properties_hash?.mtg_language || "en";
  const condition = ct.properties_hash?.condition;

  const url = `${API}/marketplace/products?blueprint_id=${blueprintId}&foil=false&language=${language}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
      },
    });

    const data = await res.json();

    const listings = data[blueprintId] || [];

    // filter ZERO + condition match
    const zeroMatches = listings.filter(p => {
      const isZero = p.user?.can_sell_via_hub === true;
      const cond = p.properties_hash?.condition;
      return isZero && cond === condition && p.quantity > 0;
    });

    if (!zeroMatches.length) continue;

    // get lowest
    const lowest = Math.min(...zeroMatches.map(p => centsToFloat(p.price.cents)));

    let newPrice = clamp(lowest - 0.01);

    nonFoilResults.push({
      name: item.name,
      current: item.price,
      lowestZero: lowest,
      newPrice,
    });

  } catch (err) {
    console.log("Error on", item.name, err.message);
  }
}

// ---- output
console.log("\n=== NON-FOIL REPRICES (5) ===\n");
console.table(nonFoilResults);

console.log("\n=== FOIL SKIPPED (5) ===\n");
console.table(foilResults);

await mongoose.disconnect();