// server/routes/orderArticles.js
import express from "express";
import axios from "axios";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";

const router = express.Router();

// Helper: Scryfall lookup by exact card name
async function getScryfallImage(cardName) {
  if (!cardName) return null;
  try {
    const resp = await axios.get("https://api.scryfall.com/cards/named", {
      params: {
        exact: cardName,
        version: "normal",
      },
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
 * Fetch items inside a CardTrader order, allocate from bins (once),
 * store that allocation in Mongo, and always return the picked bins
 * for each line item.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const orderIdStr = String(id);

  // ✅ NEW: allow background sync to skip Scryfall calls
  const skipImages = req.query.skipImages === "1";

  try {
    const client = ct();
    console.log("🔎 Fetching order items for order id:", id);

    // 1️⃣ Fetch the single order from CardTrader
    const r = await client.get(`/orders/${id}`);
    console.log("✅ CardTrader /orders/:id status:", r.status);

    const order = r.data || {};
    const rawItems = Array.isArray(order.order_items) ? order.order_items : [];

    console.log("📦 order_items length:", rawItems.length);

    // 2️⃣ Base shape from CT API (one per order line)
    const baseItems = rawItems.map((a) => ({
      id: a.id,
      cardTraderId: a.product_id ?? null,
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || null,
      image_url: null,
      binLocations: [],
    }));

    // Collect all CT listing IDs
    const ctIds = baseItems.map((i) => i.cardTraderId).filter((x) => x != null);

    // If nothing has cardTraderId, just do Scryfall and return (unless skipping)
    if (!ctIds.length) {
      const finalNoBins = await Promise.all(
        baseItems.map(async (it) => {
          const image_url = skipImages ? null : await getScryfallImage(it.name);
          return { ...it, image_url };
        })
      );
      return res.json(finalNoBins);
    }

    // 3️⃣ Load inventory items for these cardTraderIds with bins populated
    const dbItems = await InventoryItem.find({
      cardTraderId: { $in: ctIds },
    })
      .populate("locations.bin", "name label rows description")
      .exec();

    const inventoryMap = new Map();
    for (const item of dbItems) {
      inventoryMap.set(Number(item.cardTraderId), item);
    }

    // 4️⃣ Load existing allocations for this order (if already done before)
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

    const final = await Promise.all(
  baseItems.map(async (it) => {
    const ctId = Number(it.cardTraderId);
    const requestedQty = Number(it.quantity) || 0;

    // 🔹 Try to pull InventoryItem first (even if we already have an allocation)
    const invItem = Number.isFinite(ctId)
      ? inventoryMap.get(ctId)
      : null;

    // 🔹 Decide the image_url:
    // 1) If skipImages=1 → always null
    // 2) Else prefer Mongo's imageUrl
    // 3) Fallback to Scryfall only if Mongo has no image
    let image_url = null;
    if (!skipImages) {
      if (invItem?.imageUrl) {
        image_url = invItem.imageUrl;
      } else {
        image_url = await getScryfallImage(it.name);
      }
    }

    // If the line is weird / invalid, just return image + empty bins
    if (!Number.isFinite(ctId) || requestedQty <= 0) {
      return {
        ...it,
        image_url,
        binLocations: [],
      };
    }

    // If we already have an allocation for this (order + cardTraderId),
    // reuse it and DON'T re-deduct from inventory.
    const existingAlloc = allocationMap.get(ctId);
    if (existingAlloc) {
      const binLocations = (existingAlloc.pickedLocations || []).map((pl) => {
        const binValue =
          (pl.bin && (pl.bin.label || pl.bin.name)) ||
          (typeof pl.bin === "string" ? pl.bin : String(pl.bin || "?"));

        return {
          bin: binValue,
          row: pl.row,
          quantity: pl.quantity,
        };
      });

      return {
        ...it,
        image_url,
        binLocations,
      };
    }

    // Otherwise, we need to allocate from inventory *once*
    if (!invItem || !Array.isArray(invItem.locations)) {
      return {
        ...it,
        image_url,
        binLocations: [],
      };
    }

    // Allocate from bins using your strategy (largest qty first)
    const { pickedLocations, remainingLocations, unfilled } = allocateFromBins(
      invItem.locations || [],
      requestedQty
    );

    if (!pickedLocations.length) {
      return {
        ...it,
        image_url,
        binLocations: [],
      };
    }

    // How many did we actually fulfill?
    const fulfilledQty = pickedLocations.reduce(
      (sum, loc) => sum + (loc.quantity || 0),
      0
    );

    // 6️⃣ Update InventoryItem: locations + totalQuantity
    invItem.locations = remainingLocations;
    invItem.totalQuantity = Math.max(
      0,
      (invItem.totalQuantity || 0) - fulfilledQty
    );

    await invItem.save();

    // 7️⃣ Save OrderAllocation so we don't re-allocate on future calls
    const allocationDoc = new OrderAllocation({
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
    });

    await allocationDoc.save();

    // Build binLocations for UI (with bin name/label + row + qty)
    const binLocations = pickedLocations.map((pl) => {
      const binValue =
        (pl.bin && (pl.bin.label || pl.bin.name)) ||
        (typeof pl.bin === "string" ? pl.bin : String(pl.bin || "?"));

      return {
        bin: binValue,
        row: pl.row,
        quantity: pl.quantity,
      };
    });

    return {
      ...it,
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

    console.error("❌ Failed to fetch order items");
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
