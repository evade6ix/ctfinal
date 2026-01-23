import express from "express";
import { ct } from "../ctClient.js";
import { InventoryItem } from "../models/InventoryItem.js";
import axios from "axios";
import { allocateFromBins } from "../utils/allocateFromBins.js";


const router = express.Router();

/**
 * GET /api/order-articles/:id
 * Fetch items inside a CardTrader order and attach BIN LOCATIONS
 * + try to attach an image from Scryfall by card name
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const client = ct();
    console.log("🔎 Fetching order items for order id:", id);

    // 1️⃣ Fetch the single order
    const r = await client.get(`/orders/${id}`);
    console.log("✅ CardTrader /orders/:id status:", r.status);

    const order = r.data || {};

    const rawItems = Array.isArray(order.order_items)
      ? order.order_items
      : [];

    console.log("📦 order_items length:", rawItems.length);

    // 2️⃣ Map API → base shape (use product_id as cardTraderId)
    const baseItems = rawItems.map((a) => ({
      id: a.id,
      cardTraderId: a.product_id ?? null,
      name: a.name || "Unknown item",
      quantity: a.quantity ?? 0,
      // we'll fill this below
      image_url: null,
      set_name: a.expansion || null,
      binLocations: [],
    }));

    // 3️⃣ Pull BIN LOCATIONS from Mongo
    const ctIds = baseItems.map((i) => i.cardTraderId).filter(Boolean);
    console.log("🔗 product_ids for Mongo lookup:", ctIds);

        let dbItems = [];
    if (ctIds.length) {
      dbItems = await InventoryItem.find({
        cardTraderId: { $in: ctIds },
      }).populate("locations.bin", "name label rows description");
    }

    // Map: cardTraderId -> inventory doc
    const invMap = new Map();
    for (const item of dbItems) {
      invMap.set(item.cardTraderId, item);
    }


    // helper: Scryfall lookup by exact card name
    const getScryfallImage = async (cardName) => {
      if (!cardName) return null;

      try {
        const resp = await axios.get(
          "https://api.scryfall.com/cards/named",
          {
            params: {
              exact: cardName,
              version: "normal",
            },
            timeout: 4000,
          }
        );

        const data = resp.data || {};
        if (data.image_uris) {
          return (
            data.image_uris.normal ||
            data.image_uris.large ||
            data.image_uris.small ||
            null
          );
        }

        // some double-faced / weird layouts use "card_faces"
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
    };

       // 4️⃣ Allocate from bins + attach image_url
    const final = await Promise.all(
      baseItems.map(async (it) => {
        const inv = it.cardTraderId
          ? invMap.get(it.cardTraderId)
          : null;

        let pickedLocations = [];

        if (inv && it.quantity && it.quantity > 0) {
          const { pickedLocations: chosen, remainingLocations } =
            allocateFromBins(inv.locations || [], it.quantity);

          if (chosen.length > 0) {
            // Update inventory: subtract what we picked
            const totalPicked = chosen.reduce(
              (sum, loc) => sum + (loc.quantity || 0),
              0
            );

            inv.locations = remainingLocations;
            inv.totalQuantity = Math.max(
              0,
              (inv.totalQuantity || 0) - totalPicked
            );

            await inv.save();
            pickedLocations = chosen;
          }
        }

        // Format binLocations for the frontend (use bin name/label instead of raw _id)
        const binLocations = (pickedLocations || []).map((loc) => {
          const bin = loc.bin;
          let binLabel = "?";

          if (bin && typeof bin === "object") {
            binLabel =
              bin.label ||
              bin.name ||
              (bin._id ? String(bin._id) : "?");
          } else if (bin) {
            binLabel = String(bin);
          }

          return {
            bin: binLabel,
            row: loc.row,
            quantity: loc.quantity,
          };
        });

        const image_url = await getScryfallImage(it.name);

        return {
          ...it,
          binLocations,
          image_url,
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
