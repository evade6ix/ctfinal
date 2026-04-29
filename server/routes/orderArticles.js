// server/routes/order-articles.js
import express from "express";
import axios from "axios";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";

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
    null
  );
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
 * - binLocations (from allocations / live allocation)
 * - picked / pickedAt / pickedBy (from OrderAllocation, if present)
 * - isFoil / condition
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

    if (debug) {
      return res.json({ order, rawItems });
    }

    // 3️⃣ Normalize base items
    const baseItems = rawItems.map((a) => ({
      id: a.id,
      cardTraderId: a.product_id ?? null, // CT listing / product id
      blueprintId: a.blueprint_id ?? null, // CT blueprint id
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || null,
      image_url: null,
      binLocations: [],
      isFoil: extractIsFoil(a),
      condition: extractCondition(a),
    }));

    if (!baseItems.length) return res.json([]);

    // 4️⃣ Gather CT IDs
    const ctIds = baseItems
      .map((i) => i.cardTraderId)
      .filter((x) => x != null);

    // If no CT IDs, only images are possible
    if (!ctIds.length) {
      const ctx = { lookups: 0 };

      const finalNoCT = await Promise.all(
        baseItems.map(async (it) => ({
          ...it,
          image_url: skipImages
            ? null
            : await getScryfallImageLimited(it.name, ctx),
          binLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
        }))
      );

      return res.json(finalNoCT);
    }

    // 5️⃣ Inventory items for these CT listing IDs
    const dbItems = await InventoryItem.find({
      cardTraderId: { $in: ctIds },
    })
      .populate("locations.bin", "name label rows description")
      .exec();

    const inventoryMap = new Map();
    for (const item of dbItems) {
      inventoryMap.set(Number(item.cardTraderId), item);
    }

    // 6️⃣ Previous allocations for this order
    const existingAllocations = await OrderAllocation.find({
      orderId: orderIdStr,
      cardTraderId: { $in: ctIds },
    })
      .populate("pickedLocations.bin", "name label rows description")
      .exec();

    const allocationMap = new Map();
    for (const alloc of existingAllocations) {
      allocationMap.set(Number(alloc.cardTraderId), alloc);
    }

    const ctx = { lookups: 0 };

    // 7️⃣ Build final lines
    const final = await Promise.all(
      baseItems.map(async (it) => {
        const ctId = Number(it.cardTraderId);
        const requestedQty = Number(it.quantity) || 0;

        let invItem = Number.isFinite(ctId)
  ? inventoryMap.get(ctId)
  : null;

        const existingAlloc = Number.isFinite(ctId)
          ? allocationMap.get(ctId)
          : null;

        const resolvedBlueprintId =
          invItem && invItem.blueprintId != null
            ? invItem.blueprintId
            : it.blueprintId ?? null;

        let image_url = null;
        if (!skipImages) {
          image_url = await getScryfallImageLimited(it.name, ctx);
        }

        if (!Number.isFinite(ctId) || requestedQty <= 0) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
            picked: false,
            pickedAt: null,
            pickedBy: null,
          };
        }

// Already allocated: return stored allocation snapshot ONLY if it has bins.
// If it exists but has empty pickedLocations, continue below and re-allocate.
if (existingAlloc && Array.isArray(existingAlloc.pickedLocations) && existingAlloc.pickedLocations.length > 0) {
  const binLocations = existingAlloc.pickedLocations.map((pl) => ({
    bin:
      (pl.bin && (pl.bin.label || pl.bin.name)) ||
      (typeof pl.bin === "string" ? pl.bin : String(pl.bin || "?")),
    row: pl.row,
    quantity: pl.quantity,
  }));

  return {
    ...it,
    blueprintId: resolvedBlueprintId,
    image_url,
    binLocations,
    name: existingAlloc.name || it.name,
    condition: existingAlloc.condition ?? it.condition ?? null,
    isFoil: it.isFoil === true ? true : existingAlloc.isFoil ?? false,
    picked: !!existingAlloc.picked,
    pickedAt: existingAlloc.pickedAt || null,
    pickedBy: existingAlloc.pickedBy || null,
  };
}

if (existingAlloc) {
  console.warn("⚠️ EXISTING ALLOCATION HAS NO BINS - REALLOCATING", {
    orderId: orderIdStr,
    orderCode: order.code || null,
    cardTraderId: ctId,
    name: it.name,
  });
}
const hasUsableStock = (item) =>
  item &&
  Array.isArray(item.locations) &&
  item.locations.reduce((sum, loc) => sum + Number(loc.quantity || 0), 0) > 0;

if (!hasUsableStock(invItem)) {
 const normalizeCondition = (condition = "") => {
  const c = String(condition).trim().toLowerCase();

  if (c === "near mint" || c === "nm") return "NM";
  if (c === "lightly played" || c === "slightly played" || c === "lp" || c === "sp") return "LP";
  if (c === "moderately played" || c === "mp") return "MP";
  if (c === "heavily played" || c === "hp") return "HP";
  if (c === "damaged" || c === "poor" || c === "dm" || c === "dmg") return "DMG";

  return String(condition || "").trim();
};

const normalizedCondition = normalizeCondition(it.condition);

const conditionOptions =
  normalizedCondition === "NM"
    ? ["NM", "Near Mint", "near mint", "nm"]
    : normalizedCondition === "LP"
    ? ["LP", "Lightly Played", "lightly played", "Slightly Played", "slightly played", "SP", "sp"]
    : normalizedCondition === "MP"
    ? ["MP", "Moderately Played", "moderately played"]
    : normalizedCondition === "HP"
    ? ["HP", "Heavily Played", "heavily played"]
    : normalizedCondition === "DMG"
    ? ["DMG", "Damaged", "damaged", "Poor", "poor"]
    : [normalizedCondition];

const escapedName = String(it.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fallbackQuery = {
  name: new RegExp(`^${escapedName}$`, "i"),
  condition: { $in: conditionOptions },
  isFoil: it.isFoil === true,
  locations: { $exists: true, $ne: [] },
};

if (String(it.set_name || "").toLowerCase() === "torment") {
  fallbackQuery.setCode = "tor";
}
  const fallbackItem = await InventoryItem.findOne(fallbackQuery)
    .populate("locations.bin", "name label rows description")
    .exec();

  if (hasUsableStock(fallbackItem)) {
    console.warn("⚠️ USING FALLBACK INVENTORY MATCH", {
      orderId: orderIdStr,
      orderCode: order.code || null,
      soldCardTraderId: ctId,
      fallbackCardTraderId: fallbackItem.cardTraderId,
      name: it.name,
      condition: it.condition,
      isFoil: it.isFoil,
      setCode: fallbackItem.setCode,
    });

    invItem = fallbackItem;
  }
}

// Need to allocate now
if (!invItem || !Array.isArray(invItem.locations)) {
  console.warn("⚠️ NO LOCAL INVENTORY MATCH", {
    orderId: orderIdStr,
    orderCode: order.code || null,
    name: it.name,
    cardTraderId: ctId,
    requestedQty,
    condition: it.condition,
    isFoil: it.isFoil,
  });

  return {
    ...it,
    blueprintId: resolvedBlueprintId,
    image_url,
    binLocations: [],
    picked: false,
    pickedAt: null,
    pickedBy: null,
  };
}
        const { pickedLocations, remainingLocations, unfilled } =
          allocateFromBins(invItem.locations || [], requestedQty);

        if (!pickedLocations.length) {
  console.warn("⚠️ ALLOCATION FAILED", {
    orderId: orderIdStr,
    orderCode: order.code || null,
    name: it.name,
    cardTraderId: ctId,
    requestedQty,
    totalQuantity: invItem.totalQuantity,
    locations: invItem.locations,
  });

  return {
    ...it,
    blueprintId: resolvedBlueprintId,
    image_url,
    binLocations: [],
    picked: false,
    pickedAt: null,
    pickedBy: null,
  };
}

        const fulfilledQty = pickedLocations.reduce(
          (sum, loc) => sum + (loc.quantity || 0),
          0
        );

        // Update inventory
        invItem.locations = remainingLocations;
        invItem.totalQuantity = Math.max(
          0,
          (invItem.totalQuantity || 0) - fulfilledQty
        );
        await invItem.save();

        // Save allocation snapshot
        try {
          await OrderAllocation.updateOne(
            {
              orderId: orderIdStr,
              cardTraderId: ctId,
            },
            {
              $set: {
                orderCode: order.code || null,
                requestedQuantity: requestedQty,
                fulfilledQuantity: fulfilledQty,
                unfilled,
                name: it.name,
                condition: it.condition,
                isFoil: it.isFoil || invItem?.isFoil || false,
                pickedLocations: pickedLocations.map((pl) => ({
                  bin: pl.bin?._id || pl.bin,
                  row: pl.row,
                  quantity: pl.quantity,
                })),
                picked: false,
                pickedAt: null,
                pickedBy: null,
              },
            },
            { upsert: true }
          );
        } catch (err) {
          console.error("❌ Failed to save allocation", {
            orderId: orderIdStr,
            cardTraderId: ctId,
            err: err.message,
          });
        }

        const binLocations = pickedLocations.map((pl) => ({
          bin:
            (pl.bin && (pl.bin.label || pl.bin.name)) ||
            (typeof pl.bin === "string"
              ? pl.bin
              : String(pl.bin || "?")),
          row: pl.row,
          quantity: pl.quantity,
        }));

        return {
          ...it,
          blueprintId: resolvedBlueprintId,
          image_url,
          binLocations,
          picked: false,
          pickedAt: null,
          pickedBy: null,
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
      ctError: data || null,
    });
  }
});

export default router;