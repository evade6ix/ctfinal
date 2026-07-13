import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";

function finiteQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : null;
}

function unwrapProduct(data) {
  if (!data) return null;
  if (data.resource) return data.resource;
  if (data.product) return data.product;
  return data;
}

function productQuantity(data) {
  const product = unwrapProduct(data);
  return finiteQuantity(
    product?.quantity ??
      product?.stock ??
      product?.available ??
      product?.available_quantity
  );
}

function productId(data) {
  const product = unwrapProduct(data);
  return product?.id ?? data?.id ?? null;
}

async function fetchProductById(api, cardTraderId) {
  let directError = null;

  try {
    const { data } = await api.get(`/products/${cardTraderId}`);
    const quantity = productQuantity(data);
    if (quantity !== null) {
      return { product: unwrapProduct(data), quantity, source: "product" };
    }
  } catch (error) {
    directError = error;
    const status = Number(error?.response?.status || 0);
    if (status && ![404, 405].includes(status)) throw error;
  }

  const { data } = await api.get("/products/export");
  const products = Array.isArray(data)
    ? data
    : Array.isArray(data?.products)
      ? data.products
      : [];
  const product = products.find(
    (candidate) => String(productId(candidate)) === String(cardTraderId)
  );

  if (!product) {
    const error = new Error("cardtrader_listing_not_found");
    error.cause = directError;
    throw error;
  }

  const quantity = productQuantity(product);
  if (quantity === null) throw new Error("cardtrader_listing_quantity_missing");
  return { product, quantity, source: "export" };
}

async function desiredQuantityForListing(cardTraderId) {
  const matching = await InventoryItem.find({ cardTraderId })
    .select("_id totalQuantity")
    .lean();

  if (!matching.length) {
    return {
      desiredQuantity: null,
      inventoryItemIds: [],
      error: "no_mongo_inventory_for_cardtrader_listing",
    };
  }

  const desiredQuantity = matching.reduce(
    (sum, item) => sum + Math.max(0, Number(item?.totalQuantity || 0)),
    0
  );

  return {
    desiredQuantity: Math.max(0, Math.floor(desiredQuantity)),
    inventoryItemIds: matching.map((item) => item._id.toString()),
    error: null,
  };
}

export async function syncCardTraderListingQuantity(cardTraderId, context = {}) {
  const numericId = Number(cardTraderId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return {
      ok: false,
      cardTraderId: cardTraderId ?? null,
      error: "invalid_cardtrader_id",
      context,
    };
  }

  try {
    const desired = await desiredQuantityForListing(numericId);
    if (desired.error) {
      return {
        ok: false,
        cardTraderId: numericId,
        error: desired.error,
        context,
      };
    }

    const api = ct();
    const before = await fetchProductById(api, numericId);

    if (before.quantity === desired.desiredQuantity) {
      return {
        ok: true,
        cardTraderId: numericId,
        checked: true,
        updated: false,
        quantityBefore: before.quantity,
        quantityAfter: before.quantity,
        desiredQuantity: desired.desiredQuantity,
        inventoryItemIds: desired.inventoryItemIds,
        lookupSource: before.source,
      };
    }

    await api.put(`/products/${numericId}`, {
      quantity: desired.desiredQuantity,
    });

    const after = await fetchProductById(api, numericId);
    const verified = after.quantity === desired.desiredQuantity;

    return {
      ok: verified,
      cardTraderId: numericId,
      checked: true,
      updated: true,
      quantityBefore: before.quantity,
      quantityAfter: after.quantity,
      desiredQuantity: desired.desiredQuantity,
      inventoryItemIds: desired.inventoryItemIds,
      lookupSource: after.source,
      error: verified ? null : "cardtrader_quantity_verification_failed",
    };
  } catch (error) {
    console.error("❌ CardTrader quantity reconciliation failed", {
      cardTraderId: numericId,
      context,
      status: error?.response?.status || null,
      response: error?.response?.data || null,
      error: error?.message || String(error),
    });

    return {
      ok: false,
      cardTraderId: numericId,
      checked: false,
      updated: false,
      error: error?.response?.data || error?.message || String(error),
      context,
    };
  }
}

export async function syncInventoryItemIdsToCardTrader(inventoryItemIds, context = {}) {
  const ids = [...new Set((inventoryItemIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];

  const items = await InventoryItem.find({ _id: { $in: ids } })
    .select("_id cardTraderId")
    .lean();

  const results = [];
  const cardTraderIds = new Set();

  for (const item of items) {
    const cardTraderId = Number(item?.cardTraderId);
    if (!Number.isFinite(cardTraderId) || cardTraderId <= 0) {
      results.push({
        ok: false,
        inventoryItemId: item._id.toString(),
        cardTraderId: item?.cardTraderId ?? null,
        error: "inventory_item_has_no_cardtrader_listing_id",
      });
      continue;
    }
    cardTraderIds.add(cardTraderId);
  }

  for (const cardTraderId of cardTraderIds) {
    results.push(await syncCardTraderListingQuantity(cardTraderId, context));
  }

  return results;
}

// Backwards-compatible single-item entrypoint used by older routes.
export async function syncInventoryItemToCardTrader(inventoryItem, options = {}) {
  const inventoryItemId = inventoryItem?._id?.toString?.();
  if (!inventoryItemId) {
    return {
      ok: false,
      attempted: 0,
      synced: 0,
      error: "missing_inventory_item",
    };
  }

  if (options.livePush === false) {
    const cardTraderId = Number(inventoryItem?.cardTraderId);
    const desired = Number.isFinite(cardTraderId)
      ? await desiredQuantityForListing(cardTraderId)
      : { desiredQuantity: null, inventoryItemIds: [], error: "invalid_cardtrader_id" };

    return {
      ok: !desired.error,
      livePush: false,
      attempted: 1,
      synced: 0,
      cardTraderId: Number.isFinite(cardTraderId) ? cardTraderId : null,
      quantity: desired.desiredQuantity,
      inventoryItemIds: desired.inventoryItemIds,
      error: desired.error,
    };
  }

  const results = await syncInventoryItemIdsToCardTrader([inventoryItemId], options.context || {});
  const result = results[0] || {
    ok: false,
    error: "cardtrader_sync_not_attempted",
  };

  return {
    ...result,
    livePush: true,
    attempted: 1,
    synced: result.ok ? 1 : 0,
    quantity: result.desiredQuantity ?? null,
  };
}
