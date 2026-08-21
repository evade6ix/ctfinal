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

const MTG_GAME_IDS = new Set(["1"]);

function isMagicGame(game) {
  const normalized = String(game || "").trim().toLowerCase();
  return MTG_GAME_IDS.has(normalized) || normalized === "magic" || normalized === "mtg";
}

function isManaPoolSupportedItem(item) {
  // Legacy MTG rows may not have a game saved yet, so keep blank-game rows eligible.
  if (!item?.game) return true;
  return isMagicGame(item.game);
}

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
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
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
  if (typeof item.totalQuantity === "number") return Math.max(0, item.totalQuantity);
  if (Array.isArray(item.locations)) {
    return item.locations.reduce((sum, loc) => {
      const qty = typeof loc.quantity === "number" ? loc.quantity : 0;
      return sum + Math.max(0, qty);
    }, 0);
  }
  if (typeof item.quantity === "number") return Math.max(0, item.quantity);
  return 0;
}

function getPriceCents(item) {
  if (typeof item.priceCents === "number") return Math.round(item.priceCents);
  if (typeof item.price_cents === "number") return Math.round(item.price_cents);
  if (typeof item.price === "number") return Math.round(item.price * 100);
  return null;
}

function getFinishId(item) {
  return item.isFoil === true || item.foil === true ? "FO" : "NF";
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

function getGroupKey(scryfallId, languageId, conditionId, finishId) {
  return [scryfallId, languageId, conditionId, finishId].join("|");
}

function buildExternalId(scryfallId, languageId, conditionId, finishId) {
  return `G3-MP-${scryfallId}-${languageId}-${conditionId}-${finishId}`;
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
  const existingId = item.identifiers?.scryfallId || item.manapool?.scryfallId;
  if (existingId) return { id: existingId };

  const rawSetCode = String(item.setCode || "").toLowerCase();
  const possibleSetCodes = [rawSetCode];
  if (rawSetCode.startsWith("c") && rawSetCode.length > 3) {
    possibleSetCodes.push(rawSetCode.slice(1));
  }

  const uniqueSetCodes = [...new Set(possibleSetCodes)];
  let lastError = null;

  for (const setCode of uniqueSetCodes) {
    const key = `${String(item.name || "").toLowerCase()}|${setCode}`;
    if (cache.has(key)) return cache.get(key);

    const params = { exact: item.name, set: setCode };

    for (let attempt = 1; attempt <= MAX_SCRYFALL_ATTEMPTS; attempt++) {
      try {
        const res = await scryfallApi.get("/cards/named", { params });
        cache.set(key, res.data);
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        lastError = err;

        if (status === 404) break;
        if (status === 429) {
          await sleep(getRetryAfterMs(err));
          continue;
        }
        if (status >= 500 && attempt < MAX_SCRYFALL_ATTEMPTS) {
          await sleep(10000 * attempt);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastError || new Error(`Scryfall lookup failed for ${item.name}`);
}

async function loadCompleteGroup(seed, scryfallId, conditionId, finishId) {
  const or = [{ "identifiers.scryfallId": scryfallId }, { "manapool.scryfallId": scryfallId }];

  if (seed.name && seed.setCode) {
    or.push({ name: seed.name, setCode: seed.setCode });
  }

  const candidates = await InventoryItem.find({ $or: or }).sort({ updatedAt: -1 }).lean();
  const cache = new Map();
  const members = [];

  for (const candidate of candidates) {
    if (!isManaPoolSupportedItem(candidate)) continue;
    if (getConditionId(candidate) !== conditionId) continue;
    if (getFinishId(candidate) !== finishId) continue;

    try {
      const card = await findScryfallCard(candidate, cache);
      if (card.id === scryfallId) members.push(candidate);
    } catch {
      // Ignore an unrelated legacy candidate that cannot be resolved.
    }
  }

  if (!members.some((member) => String(member._id) === String(seed._id))) {
    members.push(seed);
  }

  return members;
}

async function buildAggregatedGroups(items, result) {
  const scryfallCache = new Map();
  const groups = new Map();

  for (const item of items) {
    const summary = summarizeItem(item);
    const conditionId = getConditionId(item);
    const finishId = getFinishId(item);
    const priceCents = getPriceCents(item);
    const issues = [];

    if (!item._id) issues.push("Missing Mongo _id");
    if (!item.name) issues.push("Missing name");
    if (!item.setCode && !item.identifiers?.scryfallId && !item.manapool?.scryfallId) {
      issues.push("Missing setCode and Scryfall ID");
    }
    if (!conditionId) issues.push(`Could not map condition: ${item.condition}`);
    if (!Number.isInteger(priceCents) || priceCents <= 0) issues.push("Price is missing/invalid");

    if (issues.length) {
      result.skippedBeforePush.push({ id: item._id?.toString?.() || null, summary, issues });
      continue;
    }

    try {
      const card = await findScryfallCard(item, scryfallCache);
      const key = getGroupKey(card.id, "EN", conditionId, finishId);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          scryfallId: card.id,
          languageId: "EN",
          conditionId,
          finishId,
          seed: item,
        });
      }
    } catch (err) {
      result.skippedBeforePush.push({
        id: item._id?.toString?.() || null,
        summary,
        issues: [err.response?.data || err.message],
      });
    }

    await sleep(SCRYFALL_DELAY_MS);
  }

  for (const group of groups.values()) {
    const members = await loadCompleteGroup(
      group.seed,
      group.scryfallId,
      group.conditionId,
      group.finishId
    );

    group.memberIds = [...new Set(members.map((member) => String(member._id)))];
    group.quantity = members.reduce((sum, member) => sum + getQuantity(member), 0);
    group.priceCents = members.map(getPriceCents).find((price) => Number.isInteger(price) && price > 0);
    group.customExternalId = buildExternalId(
      group.scryfallId,
      group.languageId,
      group.conditionId,
      group.finishId
    );
  }

  return groups;
}

async function updateMongoWithManaPoolResults(inventoryRows, groupsByExternalId) {
  let updated = 0;

  for (const inv of inventoryRows) {
    const group = groupsByExternalId.get(inv.custom_external_id);
    if (!group?.memberIds?.length) {
      console.warn("ManaPool returned an unknown custom_external_id:", inv.custom_external_id);
      continue;
    }

    const single = inv.product?.single || {};
    const update = {
      "identifiers.scryfallId": single.scryfall_id || group.scryfallId,
      "identifiers.mtgjsonUuid": single.mtgjson_id || null,
      "identifiers.tcgplayerProductId": single.tcgplayer_id || null,
      "identifiers.tcgplayerSkuId": inv.product?.tcgplayer_sku || null,
      "manapool.inventoryId": inv.id,
      "manapool.productId": inv.product_id || inv.product?.id || null,
      "manapool.productType": inv.product_type || "mtg_single",
      "manapool.tcgplayerSku": inv.product?.tcgplayer_sku || null,
      "manapool.scryfallId": single.scryfall_id || group.scryfallId,
      "manapool.languageId": single.language_id || group.languageId,
      "manapool.conditionId": single.condition_id || group.conditionId,
      "manapool.finishId": single.finish_id || group.finishId,
      "manapool.customExternalId": inv.custom_external_id,
      "manapool.lastSyncedAt": new Date(),
      "manapool.lastSyncedQuantity": inv.quantity,
      "manapool.lastSyncedPriceCents": inv.price_cents,
      "manapool.lastSyncError": null,
    };

    const writeResult = await InventoryItem.updateMany(
      { _id: { $in: group.memberIds } },
      { $set: update }
    );
    updated += writeResult.modifiedCount || writeResult.nModified || 0;
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
    skippedUnsupportedGame: [],
    inventory: [],
    aggregatedGroups: [],
  };

  if (!items.length) return result;

  const manaPoolItems = [];
  for (const item of items) {
    if (isManaPoolSupportedItem(item)) manaPoolItems.push(item);
    else {
      result.skippedUnsupportedGame.push({
        id: item._id?.toString?.() || null,
        game: item.game || null,
        summary: summarizeItem(item),
        reason: "ManaPool is Magic-only; skipping non-MTG inventory.",
      });
    }
  }

  if (!manaPoolItems.length) return result;

  if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
    result.ok = false;
    result.skippedBeforePush.push({
      reason: "Missing MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN",
    });
    return result;
  }

  const groups = await buildAggregatedGroups(manaPoolItems, result);
  const payload = [];
  const groupsByExternalId = new Map();

  for (const group of groups.values()) {
    if (!Number.isInteger(group.quantity) || group.quantity < 0) {
      result.skippedBeforePush.push({
        id: group.seed?._id?.toString?.() || null,
        summary: summarizeItem(group.seed || {}),
        issues: ["Aggregated quantity is invalid"],
      });
      continue;
    }

    const row = {
      scryfall_id: group.scryfallId,
      language_id: group.languageId,
      finish_id: group.finishId,
      condition_id: group.conditionId,
      price_cents: group.priceCents,
      quantity: group.quantity,
      custom_external_id: group.customExternalId,
    };

    payload.push(row);
    groupsByExternalId.set(group.customExternalId, group);
    result.aggregatedGroups.push({
      scryfallId: group.scryfallId,
      conditionId: group.conditionId,
      finishId: group.finishId,
      quantity: group.quantity,
      memberCount: group.memberIds.length,
    });
  }

  result.payloadCount = payload.length;
  if (!livePush || payload.length === 0) return result;

  const chunks = chunkArray(payload, MANAPOOL_BATCH_SIZE);

  for (const chunk of chunks) {
    try {
      const response = await manaPoolApi.post("/seller/inventory/scryfall_id", chunk);
      const inventoryRows = response.data?.inventory || [];
      const skippedRows = response.data?.skipped || [];

      result.inventory.push(...inventoryRows);
      result.skippedByManaPool.push(...skippedRows);
      result.synced += inventoryRows.length;
      result.mongoUpdated += await updateMongoWithManaPoolResults(
        inventoryRows,
        groupsByExternalId
      );
    } catch (err) {
      result.ok = false;
      const message = JSON.stringify(err.response?.data || err.message);
      const ids = chunk.flatMap((row) => groupsByExternalId.get(row.custom_external_id)?.memberIds || []);
      if (ids.length) {
        await InventoryItem.updateMany(
          { _id: { $in: ids } },
          { $set: { "manapool.lastSyncError": message } }
        );
      }
      throw err;
    }

    await sleep(500);
  }

  return result;
}
