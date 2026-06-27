// server/routes/order-articles.js
import express from "express";
import axios from "axios";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";

const router = express.Router();

/**
 * 🔒 Simple in-memory cache for Scryfall image URLs
 * key: cardName.toLowerCase()
 */
const scryfallCache = new Map();

// Max Scryfall calls allowed PER /api/order-articles/:id request
const MAX_SCRYFALL_LOOKUPS_PER_REQUEST = 50;

async function getScryfallImage(cardName) {
  if (!cardName) return null;

  try {
    const resp = await axios.get("https://api.scryfall.com/cards/named", {
      params: { exact: cardName, version: "normal" },
      timeout: 4000,
    });

    const data = resp.data || {};

    if (data.image_uris) {
      return (
        data.image_uris.normal ||
        data.image_uris.large ||
        data.image_uris.small ||
        null
      );
    }

    if (Array.isArray(data.card_faces) && data.card_faces.length > 0) {
      const face = data.card_faces[0];

      if (face.image_uris) {
        return (
          face.image_uris.normal ||
          face.image_uris.large ||
          face.image_uris.small ||
          null
        );
      }
    }

    return null;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("⚠️ Scryfall lookup failed for", cardName);
    }

    return null;
  }
}

/**
 * Wrapper: Scryfall lookup with per-request limit + cache
 * ctx.lookups is per /api/order-articles/:id request
 */
async function getScryfallImageLimited(cardName, ctx) {
  if (!cardName) return null;

  const key = String(cardName).toLowerCase();

  if (scryfallCache.has(key)) {
    return scryfallCache.get(key);
  }

  if (ctx.lookups >= MAX_SCRYFALL_LOOKUPS_PER_REQUEST) {
    return null;
  }

  ctx.lookups++;

  const url = await getScryfallImage(cardName);

  if (url) {
    scryfallCache.set(key, url);
  }

  return url;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getFirstFiniteNumber(...values) {
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n !== null) return n;
  }

  return null;
}

function extractOrderItemId(a) {
  return getFirstFiniteNumber(
    a?.id,
    a?.order_item_id,
    a?.orderItemId,
    a?.seller_order_item_id,
    a?.line_id,
    a?.lineItemId
  );
}

function extractCardTraderId(a) {
  return getFirstFiniteNumber(
    a?.product_id,
    a?.productId,
    a?.cardTraderId,
    a?.card_trader_id,
    a?.seller_product_id,
    a?.article?.product_id,
    a?.article?.id,
    a?.product?.id,
    a?.product?.product_id
  );
}

function extractBlueprintId(a) {
  return getFirstFiniteNumber(
    a?.blueprint_id,
    a?.blueprintId,
    a?.product?.blueprint_id,
    a?.product?.blueprintId,
    a?.blueprint?.id
  );
}

function extractIsFoil(a) {
  return (
    a?.isFoil === true ||
    a?.is_foil === true ||
    a?.foil === true ||
    a?.properties?.mtg_foil === true ||
    a?.properties?.foil === true ||
    a?.properties_hash?.mtg_foil === true ||
    String(a?.variant || "").toLowerCase().includes("foil") ||
    String(a?.name || "").toLowerCase().includes("foil") ||
    String(a?.description || "").toLowerCase().includes("foil")
  );
}

/**
 * Best-effort condition normalization from CardTrader line item shape
 */
function extractCondition(item) {
  return (
    item?.condition ||
    item?.card_condition ||
    item?.attributes?.condition ||
    item?.properties?.condition ||
    item?.properties_hash?.condition ||
    item?.properties_hash?.card_condition ||
    null
  );
}

function extractSetName(item) {
  return (
    item?.expansion ||
    item?.set_name ||
    item?.setName ||
    item?.product?.set_name ||
    item?.product?.expansion ||
    null
  );
}

function allocationSourceFilter() {
  return {
    $or: [{ source: "cardtrader" }, { source: { $exists: false } }],
  };
}

function allocationOrderFilter({ orderId, orderCode }) {
  if (orderCode) {
    return {
      $or: [{ orderId }, { orderCode }],
    };
  }

  return { orderId };
}

function getAllocationBinLabel(bin) {
  if (!bin) return "?";

  if (typeof bin === "object") {
    return String(bin.label || bin.name || bin._id || bin.id || "?");
  }

  return String(bin);
}

function allocationToBinLocations(allocation) {
  if (
    !allocation ||
    !Array.isArray(allocation.pickedLocations) ||
    allocation.pickedLocations.length === 0
  ) {
    return [];
  }

  return allocation.pickedLocations.map((pl) => ({
    bin: getAllocationBinLabel(pl.bin),
    row: pl.row,
    quantity: pl.quantity,
  }));
}

function legacyAllocationKey(cardTraderId, name) {
  return `${Number(cardTraderId)}_${String(name || "")
    .trim()
    .toLowerCase()}`;
}

/**
 * GET /api/order-articles/image?name=Card+Name
 * Returns a single Scryfall image URL for an exact card name.
 * Used by "Show image" buttons so we don't hit Scryfall for every line item.
 */
router.get("/image", async (req, res) => {
  try {
    const name = req.query.name;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing ?name query parameter" });
    }

    const key = name.toLowerCase();

    if (scryfallCache.has(key)) {
      return res.json({ image_url: scryfallCache.get(key) });
    }

    const url = await getScryfallImage(name);

    if (url) {
      scryfallCache.set(key, url);
    }

    return res.json({ image_url: url });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("❌ /api/order-articles/image error:", err.message || err);
    }

    return res.status(500).json({
      error: "Failed to fetch card image",
    });
  }
});

/**
 * GET /api/order-articles/:id
 * Returns normalized line items for an order, including:
 * - cardTraderId / blueprintId
 * - quantity
 * - Scryfall image_url
 * - binLocations from saved OrderAllocation.pickedLocations
 * - picked / pickedAt / pickedBy from saved OrderAllocation
 * - isFoil / condition
 *
 * Display route only: this must never allocate or deduct inventory.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const orderIdStr = String(id);

  const skipImages = req.query.skipImages === "1";
  const debug = req.query.debug === "1";

  try {
    const client = ct();

    // 1️⃣ Fetch the order from CardTrader
    const orderRes = await client.get(`/orders/${id}`);
    const order = orderRes.data || {};

    // 2️⃣ Extract line items (be generous about the shape)
    let rawItems = [];
    if (Array.isArray(order.order_items)) {
      rawItems = order.order_items;
    } else if (Array.isArray(order.items)) {
      rawItems = order.items;
    } else if (order.order_items && Array.isArray(order.order_items.data)) {
      rawItems = order.order_items.data;
    } else if (order.items && Array.isArray(order.items.data)) {
      rawItems = order.items.data;
    }

    const orderCodeStr = order.code ? String(order.code) : null;

    // 3️⃣ Normalize base items
    const baseItems = rawItems.map((a, index) => {
      const orderItemId = extractOrderItemId(a);
      const cardTraderId = extractCardTraderId(a);

      return {
        id: orderItemId ?? a?.id ?? `line-${index + 1}`,
        orderItemId,
        cardTraderId,
        blueprintId: extractBlueprintId(a),
        name: a?.name || a?.product?.name || "Unknown item",
        quantity: Number(a?.quantity ?? a?.qty ?? 0) || 0,
        set_name: extractSetName(a),
        image_url: null,
        binLocations: [],
        isFoil: extractIsFoil(a),
        condition: extractCondition(a),
      };
    });

    // 4️⃣ Load saved allocations by exact order/order code FIRST.
    // Do not require cardTraderId here: Daily Sales should still show saved bins
    // when CardTrader's live order payload omits or reshapes product_id.
    const existingAllocations = await OrderAllocation.find({
      $and: [
        allocationOrderFilter({ orderId: orderIdStr, orderCode: orderCodeStr }),
        allocationSourceFilter(),
      ],
    })
      .populate("pickedLocations.bin", "name label rows description")
      .exec();

    if (debug) {
      return res.json({
        order,
        rawItems,
        baseItems,
        existingAllocationCount: existingAllocations.length,
        existingAllocations: existingAllocations.map((a) => ({
          _id: a._id?.toString?.(),
          source: a.source,
          orderId: a.orderId,
          orderCode: a.orderCode,
          orderItemId: a.orderItemId,
          cardTraderId: a.cardTraderId,
          name: a.name,
          pickedLocations: a.pickedLocations,
          status: a.status,
        })),
      });
    }

    if (!baseItems.length) return res.json([]);

    const allocationByLine = new Map();
    const allocationByCardTraderId = new Map();
    const allocationByLegacy = new Map();

    for (const alloc of existingAllocations) {
      if (alloc.orderItemId != null) {
        allocationByLine.set(Number(alloc.orderItemId), alloc);
      }

      if (alloc.cardTraderId != null) {
        const ctId = Number(alloc.cardTraderId);
        if (!allocationByCardTraderId.has(ctId)) {
          allocationByCardTraderId.set(ctId, alloc);
        }

        allocationByLegacy.set(legacyAllocationKey(ctId, alloc.name), alloc);
      }
    }

    // 5️⃣ Inventory items are only used for image/blueprint fallback, never allocation.
    const ctIds = baseItems
      .map((i) => Number(i.cardTraderId))
      .filter((x) => Number.isFinite(x));

    const dbItems = ctIds.length
      ? await InventoryItem.find({
          cardTraderId: { $in: ctIds },
        })
          .populate("locations.bin", "name label rows description")
          .exec()
      : [];

    const inventoryMap = new Map();
    for (const item of dbItems) {
      inventoryMap.set(Number(item.cardTraderId), item);
    }

    const ctx = { lookups: 0 };

    // 6️⃣ Build final lines from saved allocation snapshots.
    const final = await Promise.all(
      baseItems.map(async (it) => {
        const ctId = Number(it.cardTraderId);
        const invItem = Number.isFinite(ctId) ? inventoryMap.get(ctId) : null;

        const existingAlloc =
          (it.orderItemId != null
            ? allocationByLine.get(Number(it.orderItemId))
            : null) ||
          (Number.isFinite(ctId) ? allocationByCardTraderId.get(ctId) : null) ||
          (Number.isFinite(ctId)
            ? allocationByLegacy.get(legacyAllocationKey(ctId, it.name))
            : null) ||
          null;

        const resolvedBlueprintId =
          invItem && invItem.blueprintId != null
            ? invItem.blueprintId
            : it.blueprintId ?? null;

        let image_url = null;
        if (!skipImages) {
          image_url = await getScryfallImageLimited(it.name, ctx);
        }

        const binLocations = allocationToBinLocations(existingAlloc);

        if (!existingAlloc) {
          console.warn("⚠️ NO SAVED ALLOCATION FOR ORDER LINE", {
            orderId: orderIdStr,
            orderCode: order.code || null,
            orderItemId: it.orderItemId ?? it.id,
            name: it.name,
            cardTraderId: Number.isFinite(ctId) ? ctId : it.cardTraderId,
            condition: it.condition,
            isFoil: it.isFoil,
            blueprintId: it.blueprintId,
          });
        } else if (!binLocations.length) {
          console.warn("⚠️ EXISTING ALLOCATION HAS NO BINS", {
            orderId: orderIdStr,
            orderCode: order.code || null,
            orderItemId: it.orderItemId ?? it.id,
            cardTraderId: existingAlloc.cardTraderId,
            name: existingAlloc.name || it.name,
            status: existingAlloc.status,
          });
        }

        return {
          ...it,
          id: it.orderItemId ?? it.id,
          cardTraderId: Number.isFinite(ctId)
            ? ctId
            : existingAlloc?.cardTraderId ?? null,
          blueprintId: resolvedBlueprintId,
          image_url,
          binLocations,
          name: existingAlloc?.name || it.name,
          condition: existingAlloc?.condition ?? it.condition ?? null,
          isFoil: it.isFoil === true ? true : existingAlloc?.isFoil ?? false,
          picked: !!existingAlloc?.picked,
          pickedAt: existingAlloc?.pickedAt || null,
          pickedBy: existingAlloc?.pickedBy || null,
        };
      })
    );

    return res.json(final);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const url = err?.config?.url;

    console.error("❌ Failed to fetch order or items");
    console.error("   ↳ URL:", url);
    console.error("   ↳ Status:", status);
    console.error("   ↳ Data:", data || err.message || err);

    return res.status(500).json({
      error: "Failed to fetch order items",
      status,
      message: err?.message || String(err),
      stack: process.env.NODE_ENV !== "production" ? err?.stack : undefined,
      ctError: data || null,
    });
  }
});

export default router;
