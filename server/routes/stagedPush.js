import express from "express";
import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";
import { applyStagedToInventory } from "../utils/applyStagedToInventory.js";
import { syncInventoryItemsToManaPool } from "../services/manapoolInventorySync.js";

const router = express.Router();

const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

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
  if (raw === "nm" || raw === "near mint") return "Near Mint";
  if (
    raw === "lp" ||
    raw === "lightly played" ||
    raw === "slightly played"
  ) {
    return "Slightly Played";
  }
  if (raw === "mp" || raw === "moderately played") return "Moderately Played";
  if (raw === "p" || raw === "played") return "Played";
  if (raw === "hp" || raw === "heavily played") return "Heavily Played";
  if (raw === "poor") return "Poor";

  return "Near Mint";
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
  const condition = normalizeCondition(raw.condition);
  const isFoil = !!raw.foil;

  return {
    ok: true,
    item: {
      blueprintId,
      quantity: intQty,
      price: roundedPrice,
      condition,
      isFoil,
      name: raw.name || "Unknown",
      setCode: raw.setCode || "",
      game: raw.gameId || raw.game || gameId || "",
    },
  };
}

function buildCardTraderPayload(item) {
  return {
    blueprint_id: item.blueprintId,
    quantity: item.quantity,
    price: item.price,
    error_mode: "strict",
    properties: {
      condition: item.condition,
      mtg_language: "en",
      mtg_foil: item.isFoil,
    },
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

    for (const raw of items) {
      const normalized = normalizeStagedItem(raw, gameId);

      if (!normalized.ok) {
        failed += 1;
        results.push({ ok: false, reason: normalized.reason, item: normalized.raw });
        continue;
      }

      const item = normalized.item;
      let cardTraderId = null;
      let cardTraderResponse = null;
      let mongoInventoryItem = null;
      let manaPoolResult = null;

      try {
        if (shouldPushCardTrader) {
          const payload = buildCardTraderPayload(item);
          const { data } = await api.post("/products", payload);
          cardTraderResponse = data;

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
          manaPoolResult = await syncInventoryItemsToManaPool(mongoInventoryItem, {
            livePush: true,
          });

          await markManaPoolSyncError(mongoInventoryItem, manaPoolResult);
        }

        created += 1;
        results.push({
          ok: true,
          mode,
          blueprintId: item.blueprintId,
          cardTraderId,
          inventoryItemId: mongoInventoryItem?._id?.toString?.() || null,
          cardtrader: cardTraderResponse,
          manapool: summarizeManaPoolResult(manaPoolResult),
        });
      } catch (err) {
        failed += 1;
        console.error(`❌ staged push failed (${mode})`, {
          item,
          status: err?.response?.status,
          response: err?.response?.data || null,
          message: err?.message || null,
        });

        results.push({
          ok: false,
          mode,
          blueprintId: item.blueprintId,
          status: err?.response?.status,
          error: err?.response?.data || err?.message || "Request failed",
        });
      }
    }

    return res.json({
      ok: true,
      mode,
      attempted: items.length,
      created,
      failed,
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
