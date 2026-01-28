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
 * Recursively scan the order object and grab the first array
 * that looks like an order-items array:
 *  - objects with product_id, OR
 *  - objects with name + quantity
 */
function findOrderItems(node) {
  if (!node) return null;

  if (Array.isArray(node)) {
    if (node.length > 0 && typeof node[0] === "object" && node[0] !== null) {
      const first = node[0];

      // Typical CardTrader shape
      if ("product_id" in first || "blueprint_id" in first) {
        return node;
      }

      // Fallback: looks like an order line
      if ("name" in first && "quantity" in first) {
        return node;
      }
    }
    return null;
  }

  if (typeof node === "object") {
    for (const key of Object.keys(node)) {
      const found = findOrderItems(node[key]);
      if (found) return found;
    }
  }

  return null;
}

/**
 * GET /api/order-articles/:id
 * Fetch items inside a CardTrader order, allocate from bins (once),
 * store that allocation in Mongo, and always return the picked bins
 * for each line item.
 *
 * Query params:
 *   - debug=1      → return raw CardTrader order JSON (no allocation)
 *   - skipImages=1 → don't call Scryfall (just use Mongo or CT CDN)
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const orderIdStr = String(id);

  const debug = req.query.debug === "1" || req.query.debug === "true";
  const skipImages =
    req.query.skipImages === "1" || req.query.skipImages === "true";

  try {
    const client = ct();
    console.log("🔎 Fetching order items for order id:", id);

    // 1️⃣ Fetch the single order from CardTrader
    const r = await client.get(`/orders/${id}`);
    console.log("✅ CardTrader /orders/:id status:", r.status);

    const order = r.data || {};

    // If debug=1 → just return the raw CardTrader order so we can inspect shape
    if (debug) {
      return res.json(order);
    }

    // 2️⃣ Extract order lines using recursive finder
    const rawItems = findOrderItems(order) || [];
    console.log("📦 extracted order_items length:", rawItems.length);

    // 3️⃣ Base shape from CT API (one per order line)
    const baseItems = rawItems.map((a) => ({
      id: a.id,
      cardTraderId: a.product_id ?? null,

      // we'll override this from Mongo if we have it
      blueprintId: a.blueprint_id ?? null,

      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      set_name: a.expansion || a.set_name || null,
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

    // 4️⃣ Load inventory items for these cardTraderIds with bins populated
    const dbItems = await InventoryItem.find({
      cardTraderId: { $in: ctIds },
    })
      .populate("locations.bin", "name label rows description")
      .exec();

    const inventoryMap = new Map();
    for (const item of dbItems) {
      inventoryMap.set(Number(item.cardTraderId), item);
    }

    // 5️⃣ Load existing allocations for this order (if already done before)
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

    // 6️⃣ Build final response, allocating from bins if needed
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

        // 🔹 Decide the blueprintId we send to the UI
        // Prefer InventoryItem.blueprintId, fallback to CT listing id
        const resolvedBlueprintId =
          invItem && invItem.blueprintId != null
            ? invItem.blueprintId
            : it.blueprintId != null
            ? it.blueprintId
            : it.cardTraderId ?? null;

        // If weird / invalid line, just return basic info
        if (!Number.isFinite(ctId) || requestedQty <= 0) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
          };
        }

        // If we already have an allocation for this (order + cardTraderId),
        // reuse it and DON'T re-deduct from inventory.
        const existingAlloc = allocationMap.get(ctId);
        if (existingAlloc) {
          const binLocations = (existingAlloc.pickedLocations || []).map(
            (pl) => {
              const binValue =
                (pl.bin && (pl.bin.label || pl.bin.name)) ||
                (typeof pl.bin === "string" ? pl.bin : String(pl.bin || "?"));

              return {
                bin: binValue,
                row: pl.row,
                quantity: pl.quantity,
              };
            }
          );

          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations,
          };
        }

        // Otherwise, we need to allocate from inventory *once*
        if (!invItem || !Array.isArray(invItem.locations)) {
          return {
            ...it,
            blueprintId: resolvedBlueprintId,
            image_url,
            binLocations: [],
          };
        }

        // Allocate from bins using your strategy (largest qty first)
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

        // How many did we actually fulfill?
        const fulfilledQty = pickedLocations.reduce(
          (sum, loc) => sum + (loc.quantity || 0),
          0
        );

        // 7️⃣ Update InventoryItem: locations + totalQuantity
        invItem.locations = remainingLocations;
        invItem.totalQuantity = Math.max(
          0,
          (invItem.totalQuantity || 0) - fulfilledQty
        );

        await invItem.save();

        // 8️⃣ Save OrderAllocation so we don't re-allocate on future calls
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
