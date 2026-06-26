import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

const SCRYFALL_DELAY_MS = process.env.SCRYFALL_DELAY_MS
  ? Number(process.env.SCRYFALL_DELAY_MS)
  : 500;

const MAX_SCRYFALL_ATTEMPTS = process.env.MAX_SCRYFALL_ATTEMPTS
  ? Number(process.env.MAX_SCRYFALL_ATTEMPTS)
  : 6;

const MANAPOOL_BATCH_SIZE = process.env.MANAPOOL_BATCH_SIZE
  ? Number(process.env.MANAPOOL_BATCH_SIZE)
  : 500;

const scryfallApi = axios.create({
  baseURL: "https://api.scryfall.com",
  timeout: 30000,
  headers: {
    Accept: "application/json",
    "User-Agent": "CTFinal-ManaPool-InventorySync/1.0",
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

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
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

  if (typeof item.quantity === "number") {
    return Math.max(0, item.quantity);
  }

  return 0;
}

function getPriceCents(item) {
  if (typeof item.priceCents === "number") return Math.round(item.priceCents);
  if (typeof item.price_cents === "number") return Math.round(item.price_cents);

  if (typeof item.price === "number") {
    return Math.round(item.price * 100);
  }

  return null;
}

function getFinishId(item) {
  if (item.isFoil === true || item.foil === true) return "FO";
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

    played: "HP",
    poor: "DMG",
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
  const rawSetCode = String(item.setCode || "").toLowerCase();

  const possibleSetCodes = [rawSetCode];

  // CardTrader can have set codes like "cafr" where Scryfall expects "afr".
  if (rawSetCode.startsWith("c") && rawSetCode.length > 3) {
    possibleSetCodes.push(rawSetCode.slice(1));
  }

  const uniqueSetCodes = [...new Set(possibleSetCodes)];
  let lastError = null;

  for (const setCode of uniqueSetCodes) {
    const key = `${String(item.name || "").toLowerCase()}|${setCode}`;

    if (cache.has(key)) return cache.get(key);

    const params = {
      exact: item.name,
      set: setCode,
    };

    for (let attempt = 1; attempt <= MAX_SCRYFALL_ATTEMPTS; attempt++) {
      try {
        const res = await scryfallApi.get("/cards/named", { params });

        cache.set(key, res.data);
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        lastError = err;

        if (status === 404) {
          console.warn(
            `⚠️ Scryfall not found for ${item.name} [${setCode}]. Trying next set code if available...`
          );
          break;
        }

        if (status === 429) {
          const waitMs = getRetryAfterMs(err);

          console.warn(
            `⚠️ Scryfall rate limited on ${item.name} [${setCode}]. Waiting ${Math.round(
              waitMs / 1000
            )} seconds, attempt ${attempt}/${MAX_SCRYFALL_ATTEMPTS}...`
          );

          await sleep(waitMs);
          continue;
        }

        if (status >= 500 && attempt < MAX_SCRYFALL_ATTEMPTS) {
          const waitMs = 10000 * attempt;

          console.warn(
            `⚠️ Scryfall server error on ${item.name} [${setCode}]. Waiting ${Math.round(
              waitMs / 1000
            )} seconds, attempt ${attempt}/${MAX_SCRYFALL_ATTEMPTS}...`
          );

          await sleep(waitMs);
          continue;
        }

        throw err;
      }
    }
  }

  throw lastError || new Error(`Scryfall lookup failed for ${item.name}`);
}

async function updateMongoWithManaPoolResults(inventoryRows) {
  let updated = 0;

  for (const inv of inventoryRows) {
    const parsed = parseCustomExternalId(inv.custom_external_id);

    if (!parsed) {
      console.warn("⚠️ Could not parse custom_external_id:", inv.custom_external_id);
      continue;
    }

    const single = inv.product?.single || {};

    await InventoryItem.updateOne(
      { _id: parsed.inventoryItemId },
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

export async function syncInventoryItemsToManaPool(inventoryItems, options = {}) {
  const livePush = options.livePush !== false;

  const items = Array.isArray(inventoryItems)
    ? inventoryItems.filter(Boolean)
    : [inventoryItems].filter(Boolean);

  const result = {
    ok: true,
    livePush,
    attempted: items.length,
    payloadCount: 0,
    synced: 0,
    mongoUpdated: 0,
    skippedBeforePush: [],
    skippedByManaPool: [],
    inventory: [],
  };

  if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
    result.ok = false;
    result.skippedBeforePush.push({
      reason: "Missing MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN",
    });
    return result;
  }

  if (!items.length) {
    return result;
  }

  const scryfallCache = new Map();
  const payload = [];

  for (const item of items) {
    const summary = summarizeItem(item);
    const quantity = getQuantity(item);
    const priceCents = getPriceCents(item);
    const finishId = getFinishId(item);
    const conditionId = getConditionId(item);

    const issues = [];

    if (!item._id) issues.push("Missing Mongo _id");
    if (!item.name) issues.push("Missing name");
    if (!item.setCode) issues.push("Missing setCode");
    if (!conditionId) issues.push(`Could not map condition: ${item.condition}`);

    if (!Number.isInteger(quantity) || quantity < 0) {
  issues.push("Quantity is invalid");
}

    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      issues.push("Price is missing/invalid");
    }

    if (issues.length > 0) {
      result.skippedBeforePush.push({
        id: item._id?.toString?.() || null,
        summary,
        issues,
      });
      continue;
    }

    try {
      const scryfallCard = await findScryfallCard(item, scryfallCache);

      payload.push({
        scryfall_id: scryfallCard.id,
        language_id: "EN",
        finish_id: finishId,
        condition_id: conditionId,
        price_cents: priceCents,
        quantity,
        custom_external_id: `G3-INV-${item._id.toString()}-${conditionId}-${finishId}`,
      });
    } catch (err) {
      result.skippedBeforePush.push({
        id: item._id?.toString?.() || null,
        summary,
        issues: [err.response?.data || err.message],
      });
    }

    await sleep(SCRYFALL_DELAY_MS);
  }

  result.payloadCount = payload.length;

  if (!livePush || payload.length === 0) {
    return result;
  }

  const chunks = chunkArray(payload, MANAPOOL_BATCH_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const response = await manaPoolApi.post("/seller/inventory/scryfall_id", chunk);

    const inventoryRows = response.data?.inventory || [];
    const skippedRows = response.data?.skipped || [];

    result.inventory.push(...inventoryRows);
    result.skippedByManaPool.push(...skippedRows);
    result.synced += inventoryRows.length;

    const updatedThisBatch = await updateMongoWithManaPoolResults(inventoryRows);
    result.mongoUpdated += updatedThisBatch;

    await sleep(500);
  }

  return result;
}
