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
    // 🔇 In production, stay quiet to avoid log spam on Railway
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
      blueprintId: a.blueprint_id ?? null, // CT blueprint id (like Catalog uses)
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || null,
      image_url: null, // will be filled with Scryfall
      binLocations: [],
      // picked fields will be added below
    }));

    if (!baseItems.length) return res.json([]);

    // 4️⃣ Gather CT IDs (for bins / allocations)
    const ctIds = baseItems
      .map((i) => i.cardTraderId)
      .filter((x) => x != null);

    // Edge case: if we truly have NO CT IDs, we can *only* do Scryfall images,
    // and we can't allocate bins anyway.
    if (!ctIds.length) {
      // per-request context for Scryfall limits
      const ctx = { lookups: 0 };

      const finalNoCT = await Promise.all(
        baseItems.map(async (it) => ({
          ...it,
          image_url: skipImages ? null : await getScryfallImageLimited(it.name, ctx),
          binLocations: [],
          picked: false,
          pickedAt: null,
          pickedBy: null,
        }))
      );
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

    // 🔁 Per-request Scryfall context (resets on each order call)
    const ctx = { lookups: 0 };

    // 7️⃣ Build final lines (Scryfall images + bins + picked state)
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
            : it.cardTraderId ?? null;

        // 💥 IMAGE LOGIC — Scryfall ONLY, but capped + cached 💥
        let image_url = null;
        if (!skipImages) {
          image_url = await getScryfallImageLimited(it.name, ctx);
        }

        //
        // 🧱 VALIDATE ITEM
        //
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
            picked: !!existingAlloc.picked,
            pickedAt: existingAlloc.pickedAt || null,
            pickedBy: existingAlloc.pickedBy || null,
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
            picked: false,
            pickedAt: null,
            pickedBy: null,
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

        // Save allocation (start as NOT picked)
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
          picked: false,
          pickedAt: null,
          pickedBy: null,
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
