import express from "express";
import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";
import { applyStagedToInventory } from "../utils/applyStagedToInventory.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();

const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

const MTG_GAME_IDS = new Set(["1"]);

function isMagicGame(game) {
  const normalized = String(game || "").trim().toLowerCase();
  return (
    MTG_GAME_IDS.has(normalized) ||
    normalized === "magic" ||
    normalized === "mtg" ||
    normalized === "magic: the gathering" ||
    normalized === "magic the gathering"
  );
}

function isKnownNonMagicGame(game) {
  const normalized = String(game || "").trim();
  return !!normalized && !isMagicGame(normalized);
}

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 20000,
  });
}

function normalizeCondition(input) {
  const raw = String(input || "").trim().toLowerCase();

  if (raw === "m" || raw === "mint") return "Mint";
  if (raw === "nm" || raw === "near mint" || raw === "near_mint") return "Near Mint";
  if (
    raw === "lp" ||
    raw === "sp" ||
    raw === "lightly played" ||
    raw === "slightly played" ||
    raw === "slightly_played"
  ) {
    return "Slightly Played";
  }
  if (raw === "mp" || raw === "moderately played" || raw === "moderately_played") return "Moderately Played";
  if (raw === "p" || raw === "played") return "Played";
  if (raw === "hp" || raw === "heavily played" || raw === "heavily_played") return "Heavily Played";
  if (raw === "poor") return "Poor";

  return "Near Mint";
}

function normalizeFoil(input) {
  if (input === true) return true;
  if (input === false || input == null) return false;

  if (typeof input === "number") return input === 1;

  const raw = String(input).trim().toLowerCase();
  if (["true", "1", "yes", "y", "foil", "foiled", "isfoil"].includes(raw)) return true;
  if (["false", "0", "no", "n", "nonfoil", "non-foil", "regular", "normal", "none"].includes(raw)) return false;

  return false;
}

function normalizeStagedItem(raw, gameId) {
  const blueprintId = Number(raw.blueprintId);
  const qty = Number(raw.quantity);

  // Dashboard NumberInput is real dollars now.
  // $0.04 means 4 cents, $1.21 means $1.21.
  const rawPriceDollars = raw.price == null ? null : Number(raw.price);
  const price = Number.isFinite(rawPriceDollars) ? rawPriceDollars : null;

  if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
    return { ok: false, reason: "Invalid blueprintId", raw };
  }

  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "Invalid quantity", raw };
  }

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: "Invalid price", raw };
  }

  const roundedPrice = Math.round(price * 100) / 100;
  const intQty = Math.floor(qty);
  const condition = normalizeCondition(raw.condition ?? raw.cardCondition ?? raw.properties?.condition);
  const isFoil = normalizeFoil(raw.foil ?? raw.isFoil ?? raw.mtg_foil ?? raw.properties?.mtg_foil);

  return {
    ok: true,
    item: {
      blueprintId,
      quantity: intQty,
      price: roundedPrice,
      condition,
      isFoil,
      rawCondition: raw.condition ?? raw.cardCondition ?? raw.properties?.condition ?? null,
      rawFoil: raw.foil ?? raw.isFoil ?? raw.mtg_foil ?? raw.properties?.mtg_foil ?? null,
      name: raw.name || "Unknown",
      setCode: raw.setCode || "",
      game: raw.gameId || raw.game || gameId || "",
    },
  };
}

function buildCardTraderPayload(item) {
  const properties = {
    condition: item.condition,
  };

  // CardTrader uses MTG-specific property names for Magic. Do not send these
  // for Riftbound / other games, because CardTrader validates properties by game.
  if (!item.game || isMagicGame(item.game)) {
    properties.mtg_language = "en";
    properties.mtg_foil = item.isFoil;
  }

  return {
    blueprint_id: item.blueprintId,
    quantity: item.quantity,
    price: item.price,
    error_mode: "strict",
    properties,
  };
}

function summarizeManaPoolResult(manaPoolResult) {
  if (!manaPoolResult) return null;

  return {
    ok: manaPoolResult.ok,
    attempted: manaPoolResult.attempted,
    payloadCount: manaPoolResult.payloadCount,
    synced: manaPoolResult.synced,
    mongoUpdated: manaPoolResult.mongoUpdated,
    skippedBeforePush: manaPoolResult.skippedBeforePush,
    skippedByManaPool: manaPoolResult.skippedByManaPool,
    error: manaPoolResult.error || null,
  };
}

function summarizeCardTraderProduct(product) {
  const resource = product?.resource || product || {};
  return {
    id: resource?.id ?? product?.id ?? null,
    blueprintId: resource?.blueprint_id ?? product?.blueprint_id ?? null,
    properties: resource?.properties || product?.properties || null,
    propertiesHash: resource?.properties_hash || product?.properties_hash || null,
  };
}

async function markManaPoolSyncError(mongoInventoryItem, manaPoolResult) {
  if (!mongoInventoryItem?._id || !manaPoolResult) return;

  const manaPoolFailed =
    !manaPoolResult?.ok ||
    manaPoolResult.payloadCount === 0 ||
    manaPoolResult.synced === 0 ||
    manaPoolResult.mongoUpdated === 0 ||
    manaPoolResult.skippedBeforePush?.length > 0 ||
    manaPoolResult.skippedByManaPool?.length > 0;

  if (!manaPoolFailed) return;

  await InventoryItem.updateOne(
    { _id: mongoInventoryItem._id },
    {
      $set: {
        "manapool.lastSyncError": JSON.stringify({
          ok: manaPoolResult?.ok,
          livePush: manaPoolResult?.livePush,
          attempted: manaPoolResult?.attempted,
          payloadCount: manaPoolResult?.payloadCount,
          synced: manaPoolResult?.synced,
          mongoUpdated: manaPoolResult?.mongoUpdated,
          skippedBeforePush: manaPoolResult?.skippedBeforePush,
          skippedByManaPool: manaPoolResult?.skippedByManaPool,
          error: manaPoolResult?.error || null,
        }),
      },
    }
  );
}

async function pushStaged(req, res, mode) {
  try {
    const { items, binId, row, gameId } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required" });
    }

    if (!binId) {
      return res.status(400).json({ error: "binId is required" });
    }

    const numericRow = Number(row);
    if (!Number.isFinite(numericRow) || numericRow < 1) {
      return res
        .status(400)
        .json({ error: "row must be a positive number (1 or higher)" });
    }

    const shouldPushCardTrader = mode === "all" || mode === "cardtrader";
    const shouldPushManaPool = mode === "all" || mode === "manapool";
    const api = shouldPushCardTrader ? ct() : null;

    const results = [];
    let created = 0;
    let failed = 0;
    let warnings = 0;

    for (const raw of items) {
      const normalized = normalizeStagedItem(raw, gameId);

      if (!normalized.ok) {
        failed += 1;
        results.push({ ok: false, reason: normalized.reason, item: normalized.raw });
        continue;
      }

      const item = normalized.item;

      if (isKnownNonMagicGame(item.game) && mode !== "cardtrader") {
        failed += 1;
        results.push({
          ok: false,
          mode,
          blueprintId: item.blueprintId,
          game: item.game,
          reason:
            "Non-MTG games can only be pushed to CardTrader. Use CardTrader Only.",
        });
        continue;
      }

      let cardTraderId = null;
      let cardTraderResponse = null;
      let mongoInventoryItem = null;
      let manaPoolResult = null;
      let cardTraderPayload = null;

      try {
        if (shouldPushCardTrader) {
          cardTraderPayload = buildCardTraderPayload(item);

          console.log("CT STAGED PUSH PAYLOAD >>>", {
            mode,
            blueprintId: item.blueprintId,
            rawCondition: item.rawCondition,
            normalizedCondition: item.condition,
            rawFoil: item.rawFoil,
            normalizedFoil: item.isFoil,
            game: item.game,
            payload: cardTraderPayload,
          });

          const { data } = await api.post("/products", cardTraderPayload);
          cardTraderResponse = data;

          console.log("CT STAGED PUSH RESPONSE >>>", summarizeCardTraderProduct(data));

          const ctProductIdRaw = data?.resource?.id ?? data?.id;
          cardTraderId = Number.isFinite(Number(ctProductIdRaw))
            ? Number(ctProductIdRaw)
            : null;

          if (!cardTraderId) {
            throw new Error("CardTrader create succeeded but no product id was returned");
          }
        }

        mongoInventoryItem = await applyStagedToInventory(
          {
            cardTraderId,
            blueprintId: item.blueprintId,
            name: item.name,
            setCode: item.setCode,
            game: item.game,
            condition: item.condition,
            isFoil: item.isFoil,
            quantity: item.quantity,
            price: item.price,
          },
          binId,
          numericRow
        );

        if (shouldPushManaPool && mongoInventoryItem) {
          try {
            manaPoolResult = await syncInventoryItemsToManaPool(mongoInventoryItem, {
              livePush: true,
            });
          } catch (err) {
            warnings += 1;
            manaPoolResult = {
              ok: false,
              attempted: 1,
              payloadCount: 0,
              synced: 0,
              mongoUpdated: 0,
              error: err?.message || "ManaPool sync threw after staged push",
            };
            console.error("⚠️ ManaPool sync warning after staged push", {
              inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
              cardTraderId,
              message: err?.message || null,
              response: err?.response?.data || null,
            });
          }

          try {
            await markManaPoolSyncError(mongoInventoryItem, manaPoolResult);
          } catch (err) {
            warnings += 1;
            console.error("⚠️ Failed to record ManaPool sync warning", {
              inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
              cardTraderId,
              message: err?.message || null,
            });
          }
        }

        created += 1;
        results.push({
          ok: true,
          mode,
          game: item.game,
          blueprintId: item.blueprintId,
          cardTraderId,
          inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
          cardtraderPayload: cardTraderPayload,
          cardtrader: summarizeCardTraderProduct(cardTraderResponse),
          manapool: summarizeManaPoolResult(manaPoolResult),
        });
      } catch (err) {
        const hadSuccessfulSideEffect = !!cardTraderId || !!mongoInventoryItem?._id || !!manaPoolResult?.synced;

        if (hadSuccessfulSideEffect) {
          created += 1;
          warnings += 1;
          console.error(`⚠️ staged push completed with warning (${mode})`, {
            item,
            cardTraderPayload,
            cardTraderId,
            inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
            manaPoolResult: summarizeManaPoolResult(manaPoolResult),
            status: err?.response?.status,
            response: err?.response?.data || null,
            message: err?.message || null,
          });

          results.push({
            ok: true,
            warning: true,
            mode,
            game: item.game,
            blueprintId: item.blueprintId,
            cardTraderId,
            inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
            cardtraderPayload: cardTraderPayload,
            cardtrader: summarizeCardTraderProduct(cardTraderResponse),
            manapool: summarizeManaPoolResult(manaPoolResult),
            warningMessage: err?.response?.data || err?.message || "Completed with warning after live side effect",
          });
        } else {
          failed += 1;
          console.error(`❌ staged push failed (${mode})`, {
            item,
            cardTraderPayload,
            status: err?.response?.status,
            response: err?.response?.data || null,
            message: err?.message || null,
          });

          results.push({
            ok: false,
            mode,
            game: item.game,
            blueprintId: item.blueprintId,
            cardTraderPayload,
            status: err?.response?.status,
            error: err?.response?.data || err?.message || "Request failed",
          });
        }
      }
    }

    return res.json({
      ok: true,
      mode,
      attempted: items.length,
      created,
      failed,
      warnings,
      results,
    });
  } catch (err) {
    console.error(`Error in staged push (${mode})`, err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}

router.post("/all", (req, res) => pushStaged(req, res, "all"));
router.post("/cardtrader", (req, res) => pushStaged(req, res, "cardtrader"));
router.post("/manapool", (req, res) => pushStaged(req, res, "manapool"));

export default router;
