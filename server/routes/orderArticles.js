// server/routes/orderArticles.js
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

/**
 * Helper: Scryfall lookup by exact card name
 * (Low-level: does a real HTTP call)
 */
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
    console.warn("⚠️ Scryfall lookup failed for", cardName);
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

  // 1) Cache hit
  if (scryfallCache.has(key)) {
    return scryfallCache.get(key);
  }

  // 2) Hit per-request cap → no more Scryfall calls
  if (ctx.lookups >= MAX_SCRYFALL_LOOKUPS_PER_REQUEST) {
    return null;
  }

  ctx.lookups++;

  // 3) Actual Scryfall fetch
  const url = await getScryfallImage(cardName);
  if (url) {
    scryfallCache.set(key, url);
  }

  return url;
}

/**
 * GET /api/order-articles/image?name=Card+Name
 * Returns a single Scryfall image URL for an exact card name.
 * Used by "Show image" buttons so we don't hit Scryfall for every line item.
 *
 * This endpoint is OPTIONAL – your current OrdersView doesn't use it,
 * but DailyView can, or you can add "View image" buttons later.
 */
router.get("/image", async (req, res) => {
  try {
    const name = req.query.name;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing ?name query parameter" });
    }

    const key = name.toLowerCase();

    // 1) Check cache first
    if (scryfallCache.has(key)) {
      return res.json({ image_url: scryfallCache.get(key) });
    }

    // 2) Direct Scryfall lookup
    const url = await getScryfallImage(name);

    if (url) {
      scryfallCache.set(key, url);
    }

    return res.json({ image_url: url });
  } catch (err) {
    console.error("❌ /api/order-articles/image error:", err.message || err);
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
 * - binLocations (from allocations / live allocation)
 *
 * ❗ NO SCRYFALL HERE.
 * Images are provided by CardTrader blueprint URLs (image_url),
 * and your frontend can still fall back to blueprintId/cardTraderId.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const orderIdStr = String(id);

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
      blueprintId: a.blueprint_id ?? null, // CT blueprint id (like Catalog uses)
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || null,
      image_url: null, // will be filled with CardTrader URL below
      binLocations: [],
    }));

    if (!baseItems.length) return res.json([]);

    // 4️⃣ Gather CT IDs (for bins / allocations)
    const ctIds = baseItems
      .map((i) => i.cardTraderId)
      .filter((x) => x != null);

    // Edge case: if we truly have NO CT IDs, we can't allocate bins anyway.
    if (!ctIds.length) {
      const finalNoCT = baseItems.map((it) => ({
        ...it,
        // Try to give an image if we at least have blueprintId
        image_url: it.blueprintId
          ? `https://img.cardtrader.com/blueprints/${it.blueprintId}/front.jpg`
          : null,
        binLocations: [],
      }));
      return res.json(finalNoCT);
    }

    // 5️⃣ Inventory items for these CT listing IDs (for bins)
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

    // We keep ctx here but DO NOT call Scryfall in this route anymore.
    const ctx = { lookups: 0 };

    // 7️⃣ Build final lines (bins + allocations, CardTrader image URL)
    const final = await Promise.all(
      baseItems.map(async (it) => {
        const ctId = Number(it.cardTraderId);
        const requestedQty = Number(it.quantity) || 0;

        const invItem = Number.isFinite(ctId)
          ? inventoryMap.get(ctId)
          : null;

        // Decide blueprintId first – prefer Mongo, then fall back to CT id
        const resolvedBlueprintId =
          invItem && invItem.blueprintId != null
            ? invItem.blueprintId
            : it.blueprintId != null
            ? it.blueprintId
            : it.cardTraderId ?? null;

        // ✅ CardTrader blueprint image (NO Scryfall)
        const image_url = resolvedBlueprintId
          ? `https://img.cardtrader.com/blueprints/${resolvedBlueprintId}/front.jpg`
          : null;

        //
        // 🧱 VALIDATE ITEM
        //
        if (!Number.isFinite(ctId) || requestedQty <= 0) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
          };
        }

        //
        // 🔄 ALREADY ALLOCATED?
        //
        const existingAlloc = allocationMap.get(ctId);
        if (existingAlloc) {
          const binLocations = (existingAlloc.pickedLocations || []).map(
            (pl) => ({
              bin:
                (pl.bin && (pl.bin.label || pl.bin.name)) ||
                (typeof pl.bin === "string"
                  ? pl.bin
                  : String(pl.bin || "?")),
              row: pl.row,
              quantity: pl.quantity,
            })
          );

          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations,
          };
        }

        //
        // 🔄 NEED TO ALLOCATE NOW
        //
        if (!invItem || !Array.isArray(invItem.locations)) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
          };
        }

        const { pickedLocations, remainingLocations, unfilled } =
          allocateFromBins(invItem.locations || [], requestedQty);

        if (!pickedLocations.length) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
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

        // Save allocation
        await new OrderAllocation({
          orderId: orderIdStr,
          orderCode: order.code || null,
          cardTraderId: ctId,
          requestedQuantity: requestedQty,
          fulfilledQuantity: fulfilledQty,
          unfilled,
          pickedLocations: pickedLocations.map((pl) => ({
            bin: pl.bin?._id || pl.bin,
            row: pl.row,
            quantity: pl.quantity,
          })),
        }).save();

        // Build output binLocations
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
