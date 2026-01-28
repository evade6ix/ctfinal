// server/routes/orderArticles.js
import express from "express";
import axios from "axios";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";

const router = express.Router();

/**
 * Helper: Scryfall lookup by exact card name
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
 * GET /api/order-articles/:id
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const orderIdStr = String(id);

  const skipImages = req.query.skipImages === "1";
  const debug = req.query.debug === "1";

  try {
    const client = ct();

    // 1️⃣ Fetch the order
    const orderRes = await client.get(`/orders/${id}`);
    const order = orderRes.data || {};

    // 2️⃣ CT already gives items inline
    const rawItems = Array.isArray(order.order_items)
      ? order.order_items
      : [];

    if (debug) {
      return res.json({ order, order_items: rawItems });
    }

    // 3️⃣ Normalize base items
    const baseItems = rawItems.map((a) => ({
      id: a.id,
      cardTraderId: a.product_id ?? null,
      blueprintId: null,
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || null,
      image_url: null,
      binLocations: [],
    }));

    if (!baseItems.length) return res.json([]);

    // 4️⃣ Gather CT IDs
    const ctIds = baseItems
      .map((i) => i.cardTraderId)
      .filter((x) => x != null);

    // If no valid CT IDs, only Scryfall is possible
    if (!ctIds.length) {
      const finalNoCT = await Promise.all(
        baseItems.map(async (it) => ({
          ...it,
          image_url: skipImages ? null : await getScryfallImage(it.name),
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

    // 7️⃣ Build final lines
    const final = await Promise.all(
      baseItems.map(async (it) => {
        const ctId = Number(it.cardTraderId);
        const requestedQty = Number(it.quantity) || 0;

        const invItem = Number.isFinite(ctId)
          ? inventoryMap.get(ctId)
          : null;

        //
        // 💥 IMAGE LOGIC — FIXED & CORRECT 💥
        //
        let image_url = null;

        if (!skipImages) {
          // Try Mongo first
          if (invItem?.imageUrl) {
            image_url = invItem.imageUrl;
          }

          // If Mongo has no image, ALWAYS use CT CDN (blueprint)
          if (!image_url) {
            const blueprint = invItem?.blueprintId ?? it.cardTraderId;
            if (blueprint) {
              image_url = `https://img.cardtrader.com/blueprints/${blueprint}/front.jpg`;
            }
          }

          // Final fallback → Scryfall
          if (!image_url) {
            image_url = await getScryfallImage(it.name);
          }
        }

        // Now that image_url is set, compute blueprintId correctly
        const resolvedBlueprintId =
          invItem && invItem.blueprintId != null
            ? invItem.blueprintId
            : it.cardTraderId ?? null;

        // LAST guaranteed fallback: CT CDN
        if (!image_url && resolvedBlueprintId) {
          image_url = `https://img.cardtrader.com/blueprints/${resolvedBlueprintId}/front.jpg`;
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
