import { ct } from "../ctClient.js";

function getQuantity(item) {
  if (!item) return 0;

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

function getCardTraderUpdateMethods() {
  const preferred = String(process.env.CARDTRADER_UPDATE_METHOD || "")
    .trim()
    .toLowerCase();

  if (preferred === "put") return ["put"];
  if (preferred === "patch") return ["patch"];

  // Try PATCH first, then PUT as fallback.
  // CardTrader create/list routes already use /products.
  return ["patch", "put"];
}

export async function syncInventoryItemToCardTrader(inventoryItem, options = {}) {
  const livePush = options.livePush !== false;

  const cardTraderId = Number(inventoryItem?.cardTraderId);
  const quantity = getQuantity(inventoryItem);

  const result = {
    ok: true,
    livePush,
    attempted: inventoryItem ? 1 : 0,
    cardTraderId: Number.isFinite(cardTraderId) ? cardTraderId : null,
    quantity,
    synced: 0,
    method: null,
    response: null,
    skipped: [],
    error: null,
  };

  if (!inventoryItem) {
    result.ok = false;
    result.skipped.push({ reason: "Missing inventoryItem" });
    return result;
  }

  if (!Number.isFinite(cardTraderId) || cardTraderId <= 0) {
    result.ok = false;
    result.skipped.push({
      reason: "Missing/invalid cardTraderId",
      inventoryItemId: inventoryItem._id?.toString?.() || null,
    });
    return result;
  }

  if (!Number.isInteger(quantity) || quantity < 0) {
    result.ok = false;
    result.skipped.push({
      reason: "Invalid quantity",
      quantity,
      inventoryItemId: inventoryItem._id?.toString?.() || null,
      cardTraderId,
    });
    return result;
  }

  const payload = {
    quantity,
    error_mode: "strict",
  };

  if (!livePush) {
    result.response = {
      dryRun: true,
      payload,
    };
    return result;
  }

  const api = ct();
  const methods = getCardTraderUpdateMethods();

  let lastError = null;

  for (const method of methods) {
    try {
      const response = await api[method](`/products/${cardTraderId}`, payload);

      result.synced = 1;
      result.method = method.toUpperCase();
      result.response = response.data || null;

      console.log("✅ [CardTrader] Inventory quantity synced", {
        cardTraderId,
        quantity,
        method: result.method,
        inventoryItemId: inventoryItem._id?.toString?.() || null,
      });

      return result;
    } catch (err) {
      lastError = err;

      const status = err?.response?.status;

      console.error("❌ [CardTrader] Quantity sync attempt failed", {
        cardTraderId,
        quantity,
        method: method.toUpperCase(),
        status,
        error: err?.response?.data || err?.message || err,
      });

      // If the method is unsupported/not found, try the fallback method.
      if ((status === 404 || status === 405) && methods.length > 1) {
        continue;
      }

      break;
    }
  }

  result.ok = false;
  result.error =
    lastError?.response?.data || lastError?.message || "CardTrader sync failed";

  return result;
}