import express from "express";
import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";
import { ChangeLog } from "../models/ChangeLog.js";
import { applyStagedToInventory } from "../utils/applyStagedToInventory.js";

const router = express.Router();


// =======================
// CardTrader API Client
// =======================
const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing CARDTRADER_TOKEN in .env");
}

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 20000,
  });
}

// -------------------------
// Tiny in-memory caches
// -------------------------
const cache = {
  expansions: { at: 0, data: null },
  blueprintsByExpansion: new Map(), // expansion_id -> { at, data }
  marketByKey: new Map(), // `${blueprintId}:${foil}` -> { at, data }
};

const TTL_EXPANSIONS_MS = 60 * 60 * 1000; // 1 hour
const TTL_BLUEPRINTS_MS = 30 * 60 * 1000; // 30 min
const TTL_MARKET_MS = 30 * 1000; // 30 sec

// -------------------------
// Simple health / info
// -------------------------
router.get("/info", async (req, res) => {
  try {
    const { data } = await ct().get("/info");
    res.json(data);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: "info_failed",
      details: e?.response?.data || e.message,
    });
  }
});

// -------------------------
// Magic expansions (sets)
// Game id for Magic is 1
// -------------------------
router.get("/expansions", async (req, res) => {
  try {
    const now = Date.now();
    if (cache.expansions.data && now - cache.expansions.at < TTL_EXPANSIONS_MS) {
      return res.json(cache.expansions.data);
    }

    const { data } = await ct().get("/expansions");
    const magic = Array.isArray(data)
      ? data.filter((x) => x.game_id === 1)
      : [];

    cache.expansions = { at: now, data: magic };
    res.json(magic);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: "expansions_failed",
      details: e?.response?.data || e.message,
    });
  }
});

// -------------------------
// Blueprints for a set (expansion)
// GET /api/ct/blueprints?expansion_id=123
// -------------------------
router.get("/blueprints", async (req, res) => {
  try {
    const expansion_id = Number(req.query.expansion_id);
    if (!Number.isFinite(expansion_id) || expansion_id <= 0) {
      return res
        .status(422)
        .json({ error: "missing_parameter", message: "expansion_id is required" });
    }

    const now = Date.now();
    const cached = cache.blueprintsByExpansion.get(expansion_id);
    if (cached && now - cached.at < TTL_BLUEPRINTS_MS) {
      return res.json(cached.data);
    }

    const { data } = await ct().get("/blueprints/export", {
      params: { expansion_id },
    });

    cache.blueprintsByExpansion.set(expansion_id, { at: now, data });
    res.json(data);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: "blueprints_failed",
      details: e?.response?.data || e.message,
    });
  }
});

// -------------------------
// CardTrader "market price"
// GET /api/ct/market?blueprint_id=123&foil=true|false
// -------------------------
router.get("/market", async (req, res) => {
  try {
    const blueprint_id = Number(req.query.blueprint_id);
    const foil = String(req.query.foil ?? "false") === "true";

    if (!Number.isFinite(blueprint_id) || blueprint_id <= 0) {
      return res
        .status(422)
        .json({ error: "missing_parameter", message: "blueprint_id is required" });
    }

    const key = `${blueprint_id}:${foil ? "1" : "0"}`;
    const now = Date.now();
    const cached = cache.marketByKey.get(key);
    if (cached && now - cached.at < TTL_MARKET_MS) {
      return res.json(cached.data);
    }

    const { data } = await ct().get("/marketplace/products", {
      params: {
        blueprint_id,
        foil,
        language: "en",
      },
    });

    const arr = data?.[String(blueprint_id)] || [];
    let market = null;

    if (Array.isArray(arr) && arr.length) {
      const cheapest = arr
        .filter((x) => x?.price?.cents != null)
        .sort((a, b) => a.price.cents - b.price.cents)[0];

      if (cheapest?.price?.cents != null) {
        market = Number(cheapest.price.cents) / 100;
      }
    }

    const payload = { blueprint_id, foil, market };
    cache.marketByKey.set(key, { at: now, data: payload });
    res.json(payload);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: "market_failed",
      details: e?.response?.data || e.message,
    });
  }
});



// =======================
// PUSH STAGED LIVE → CARDTRADER
// POST /api/ct/products/push-all
// body: { items: [...], binId, row }
// =======================
router.post("/products/push-all", async (req, res) => {
  try {
    const api = ct();

    const { items, binId, row } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required" });
    }

    if (!binId) {
      return res.status(400).json({ error: "binId is required" });
    }

    const numericRow = Number(row);
    if (!Number.isFinite(numericRow) || numericRow < 1 || numericRow > 5) {
      return res
        .status(400)
        .json({ error: "row must be a number between 1 and 5" });
    }

    const results = [];
    let created = 0;

    for (const it of items) {
      const blueprintId = Number(it.blueprintId);
      const qty = Number(it.quantity);
      const price = it.price == null ? null : Number(it.price);

      if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
        results.push({ ok: false, reason: "Invalid blueprintId", item: it });
        continue;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        results.push({ ok: false, reason: "Invalid quantity", item: it });
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        results.push({ ok: false, reason: "Invalid price", item: it });
        continue;
      }

      const roundedPrice = Math.round(price * 100) / 100;
      const intQty = Math.floor(qty);

      const payload = {
        blueprint_id: blueprintId,
        quantity: intQty,
        price: roundedPrice,
        condition: it.condition || "NM",
        foil: !!it.foil,
        language: "en",
      };

            try {
        // 1) Push to CardTrader
const { data } = await api.post("/products", payload);
created += 1;

// CardTrader listing/product id (this is what /inventory uses as cardTraderId)
// Response shape from CT is usually: { result, warnings, resource: { id, ... } }
const ctProductIdRaw = data?.resource?.id ?? data?.id;
const cardTraderId = Number.isFinite(Number(ctProductIdRaw))
  ? Number(ctProductIdRaw)
  : null;
console.log("CT /products response:", JSON.stringify(data, null, 2));


        results.push({
          ok: true,
          blueprintId,
          cardTraderId,
          response: data,
        });

        // 2) Reflect this staged listing into Mongo inventory + bins
        if (cardTraderId != null) {
          try {
            // ✅ Reuse the SAME helper as /debug/apply so behavior matches
            const stagedForMongo = {
              cardTraderId,
              name: it.name || "Unknown",
              setCode: it.setCode || null,
              game: it.gameId || it.game || null,
              condition: it.condition || "NM",
              isFoil: !!it.foil,
              quantity: intQty,
              price: roundedPrice,
            };

            await applyStagedToInventory(stagedForMongo, binId, numericRow);
          } catch (dbErr) {
            console.error("❌ Failed to sync to Mongo inventoryItems in push-all", {
              cardTraderId,
              error: dbErr?.message || dbErr,
            });
          }
        }
      } catch (err) {
        results.push({
          ok: false,
          blueprintId,
          status: err?.response?.status,
          error: err?.response?.data || err?.message || "Request failed",
        });
      }

    }

    // ✅ route-level response after the loop
    res.json({
      ok: true,
      attempted: items.length,
      created,
      failed: items.length - created,
      results,
    });
  } catch (e) {
    console.error("Error in /products/push-all", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});






// -------------------------
// My Inventory – paginated CardTrader data
// GET /api/ct/inventory
// ALSO: syncs Mongo InventoryItem with setCode from blueprint.expansion
// -------------------------
router.get("/inventory", async (req, res) => {
  try {
    const api = ct();

    const PER_PAGE = 50;
    const MAX_PAGES = 40; // safety
    const all = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await api.get("/products", {
        params: {
          page,
          per_page: PER_PAGE,
        },
      });

      const raw = Array.isArray(data) ? data : data.products || [];

      if (!raw.length) {
        break;
      }

      all.push(...raw);

      if (raw.length < PER_PAGE) break;
    }

    // Map into response items AND prep Mongo upserts
    const items = all.map((p) => {
      const blueprint = p.blueprint || p.product_blueprint || p.product || {};
      const expansion = blueprint.expansion || {};
      const gameObj = blueprint.game || p.game || {};

      // What we will store as "setCode" in Mongo & show in UI
      const setCode =
        expansion.code ||
        expansion.shortCode ||
        expansion.short_code ||
        expansion.name ||
        p.expansion_name ||
        "";

      const priceCents =
        (p.price && p.price.cents) ??
        p.price_cents ??
        (p.list_price && p.list_price.cents) ??
        null;

      const marketPriceCents =
        (p.market_price && p.market_price.cents) ??
        p.market_price_cents ??
        null;

      const game =
        (typeof gameObj.id !== "undefined"
          ? String(gameObj.id)
          : typeof p.game_id !== "undefined"
          ? String(p.game_id)
          : "") || "";

      const quantity = p.quantity || p.stock || p.available || 0;

      // --- prepare what we send to the frontend ---
      return {
        id: p.id,
        productId: blueprint.id || p.blueprint_id || p.product_id,
        name: blueprint.name || p.name || "Unknown",
        setName: expansion.name || p.expansion_name || "",
        game: gameObj.name || "",
        language: p.language || p.language_code || "EN",
        condition: p.condition || p.state || "NM",
        isFoil:
          !!p.foil ||
          !!p.is_foil ||
          (typeof p.finish === "string" &&
            p.finish.toLowerCase().includes("foil")),
        quantity,
        listPrice: priceCents != null ? Number(priceCents) / 100 : 0,
        marketPrice:
          marketPriceCents != null ? Number(marketPriceCents) / 100 : null,

        // extra fields (not strictly needed on UI, but nice to have)
        _mongoSync: {
          cardTraderId: p.id,
          name: blueprint.name || p.name || "Unknown",
          setCode,
          game,
          condition: p.condition || p.state || "NM",
          isFoil:
            !!p.foil ||
            !!p.is_foil ||
            (typeof p.finish === "string" &&
              p.finish.toLowerCase().includes("foil")),
          price:
            priceCents != null ? Number(priceCents) / 100 : 0,
          totalQuantity: quantity,
        },
      };
    });

    // --- BACKFILL INTO MONGO, USING BLUEPRINT / EXPANSION INFO ---
    // Fire-and-forget: don't block the response if Mongo is slow
    try {
      const ops = items
        .map((it) => it._mongoSync)
        .filter((m) => m && m.cardTraderId);

      if (ops.length > 0) {
        await Promise.all(
          ops.map((m) =>
            InventoryItem.findOneAndUpdate(
              { cardTraderId: m.cardTraderId },
              {
                // don't touch totalQuantity if it already exists,
                // but if it doesn't, set it
                $setOnInsert: {
                  cardTraderId: m.cardTraderId,
                  totalQuantity: m.totalQuantity ?? 0,
                },
                $set: {
                  name: m.name,
                  setCode: m.setCode, // <-- THIS is what you wanted from blueprint.expansion
                  game: m.game,
                  condition: m.condition,
                  isFoil: m.isFoil,
                  price: m.price,
                },
              },
              { upsert: true }
            )
          )
        );
      }
    } catch (mongoErr) {
      console.error("⚠️ Failed to sync /inventory page into Mongo:", mongoErr);
      // but we still return the data to the UI
    }

    // Strip the _mongoSync helper before returning
    const cleanItems = items.map(({ _mongoSync, ...rest }) => rest);

    res.json({ items: cleanItems });
  } catch (error) {
    console.error("Error in /api/ct/inventory", error?.response?.data || error);
    res.status(error?.response?.status || 500).json({
      error: "Failed to load inventory from CardTrader",
      details: error?.response?.data || error.message,
    });
  }
});

// =======================
// SYNC CARDTRADER ORDERS → MONGO INVENTORY
// POST /api/ct/sync-orders
// Uses /orders and skips orders already applied (via ChangeLog)
// =======================
router.post("/sync-orders", async (req, res) => {
  try {
    const api = ct();

    const PER_PAGE = 50;
    const MAX_PAGES = 5; // safety so we don't hammer the API
    const allOrders = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await api.get("/orders", {
        params: {
          page,
          per_page: PER_PAGE,
          // You can add filters later if the API supports them, e.g.:
          // role: "seller",
          // state: "completed",
        },
      });

      const arr = Array.isArray(data)
        ? data
        : Array.isArray(data.orders)
        ? data.orders
        : [];

      if (!arr.length) break;

      allOrders.push(...arr);

      if (arr.length < PER_PAGE) break;
    }

    if (allOrders.length > 0) {
      console.log(
        "🔍 Sample CT order:",
        JSON.stringify(allOrders[0], null, 2)
      );
    } else {
      console.log("🔍 No CT orders returned from /orders");
    }

    let totalAppliedLines = 0;
    const perOrder = [];

    for (const order of allOrders) {
      // Normalize orderId same way as in applyOrderToInventory
      const orderIdRaw = order?.id ?? order?.order_id ?? order?.number;
      const orderId = Number.isFinite(Number(orderIdRaw))
        ? Number(orderIdRaw)
        : null;

      // 🔒 Skip orders we've already applied at least once
      if (
        orderId &&
        (await ChangeLog.exists({
          type: "order-applied",
          orderId,
        }))
      ) {
        perOrder.push({
          orderId,
          appliedLines: 0,
          skipped: true,
          reason: "already_applied",
        });
        continue;
      }

      // First time seeing this order → actually apply to inventory
      const result = await applyOrderToInventory(order);
      totalAppliedLines += result.appliedLines;
      perOrder.push({
        orderId: result.orderId,
        appliedLines: result.appliedLines,
        skipped: false,
      });
    }

    return res.json({
      ok: true,
      fetchedOrders: allOrders.length,
      appliedLines: totalAppliedLines,
      perOrder,
    });
  } catch (e) {
    console.error("Error in /api/ct/sync-orders:", e?.response?.data || e);
    return res.status(e?.response?.status || 500).json({
      ok: false,
      error: e?.message || "Server error",
      details: e?.response?.data || null,
    });
  }
});







// -------------------------
// Helper: apply ONE CardTrader order to Mongo inventory
// -------------------------
async function applyOrderToInventory(order) {
  // Normalize order ID
  const orderIdRaw = order?.id ?? order?.order_id ?? order?.number;
  const orderId = Number.isFinite(Number(orderIdRaw))
    ? Number(orderIdRaw)
    : null;

  // CardTrader shape: order.order_items[]
  const lines =
    order?.order_items ||
    order?.items ||
    order?.order_lines ||
    order?.lines ||
    order?.products ||
    [];

  if (!Array.isArray(lines) || lines.length === 0) {
    return { orderId, appliedLines: 0 };
  }

  let appliedLines = 0;

  for (const line of lines) {
    // CardTrader listing/product id (this is what we stored as cardTraderId in Mongo)
    // IMPORTANT: use product_id, not the line's own id
    const lineProduct = line.product || line.listing || line.blueprint || line;

    const cardTraderIdRaw =
      line.product_id ??                     // <- primary for CardTrader orders
      lineProduct?.product_id ??
      lineProduct?.listing_id ??
      lineProduct?.cardtrader_id ??
      null;

    const cardTraderId = Number.isFinite(Number(cardTraderIdRaw))
      ? Number(cardTraderIdRaw)
      : null;

    const qtyRaw =
      line.quantity ??
      line.qty ??
      line.amount ??
      line.units ??
      line.count ??
      0;

    const soldQty = Number(qtyRaw);

    if (!cardTraderId || !Number.isFinite(soldQty) || soldQty <= 0) {
      // Can't do anything with this line
      continue;
    }

    // Load inventory item from Mongo
    const inv = await InventoryItem.findOne({ cardTraderId });
    if (!inv) {
      // log missing mapping so we know something didn't match
      await ChangeLog.create({
        type: "order-applied",
        source: "cardtrader",
        message: `Order ${
          orderId ?? "?"
        }: product ${cardTraderId} not found in InventoryItem, no quantity changed`,
        orderId: orderId ?? undefined,
        cardTraderId,
        deltaQuantity: 0,
        details: { reason: "inventory_not_found", soldQty },
      });
      continue;
    }

    // Subtract from locations in order (simple FIFO across locations array)
    let remaining = soldQty;
    let totalRemoved = 0;

    const locations = Array.isArray(inv.locations) ? inv.locations : [];

    for (const loc of locations) {
      if (remaining <= 0) break;
      const locQty = Number(loc.quantity) || 0;

      if (locQty <= 0) continue;

      if (locQty >= remaining) {
        // we can fulfill the rest from this location
        loc.quantity = locQty - remaining;
        totalRemoved += remaining;
        remaining = 0;
      } else {
        // empty this location and keep going
        loc.quantity = 0;
        totalRemoved += locQty;
        remaining -= locQty;
      }
    }

    // Update totalQuantity safely
    if (totalRemoved > 0) {
      const currentTotal = Number(inv.totalQuantity) || 0;
      const newTotal = Math.max(0, currentTotal - totalRemoved);
      inv.totalQuantity = newTotal;
      inv.markModified("locations");
      await inv.save();
    }

    // Log the change (even if totalRemoved = 0, so you see it in ChangeLog)
    await ChangeLog.create({
      type: "order-applied",
      source: "cardtrader",
      message: `Applied CardTrader order ${
        orderId ?? "?"
      }: -${soldQty}x ${inv.name || "Unknown"} (removed ${totalRemoved} from stock)`,
      orderId: orderId ?? undefined,
      cardTraderId,
      deltaQuantity: -totalRemoved,
      details: {
        soldQtyRequested: soldQty,
        soldQtyApplied: totalRemoved,
        remainingUnfulfilled: Math.max(0, soldQty - totalRemoved),
      },
    });

    appliedLines += 1;
  }

  return { orderId, appliedLines };
}

// =======================
// TEMP DEBUG ROUTE — bypasses CardTrader API
// Writes directly into Mongo inventory + bins
// =======================
router.post("/debug/apply", async (req, res) => {
  try {
    const {
      cardTraderId,
      name,
      setCode,
      game,
      condition,
      isFoil,
      quantity,
      binId,
      row,
    } = req.body;

    if (!cardTraderId) {
      return res.status(400).json({ error: "cardTraderId missing" });
    }
    if (!binId) {
      return res.status(400).json({ error: "binId missing" });
    }

    const staged = {
      cardTraderId,
      name: name || "Test Card",
      setCode: setCode || "TST",
      game: game || "MTG",
      condition: condition || "NM",
      isFoil: !!isFoil,
      quantity: quantity || 1,
      price: 0.25,
    };

    await applyStagedToInventory(staged, binId, row || 1);

    const doc = await InventoryItem.findOne({ cardTraderId }).lean();

    res.json({
      ok: true,
      appliedToMongo: doc,
    });
  } catch (err) {
    console.error("debug/apply error", err);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// DELETE: remove entire InventoryItem by cardTraderId
// DELETE /api/ct/inventory/:cardTraderId
// =======================
router.delete("/inventory/:cardTraderId", async (req, res) => {
  try {
    const cardTraderId = Number(req.params.cardTraderId);
    if (!Number.isFinite(cardTraderId)) {
      return res.status(400).json({ error: "Invalid cardTraderId" });
    }

    const deleted = await InventoryItem.findOneAndDelete({ cardTraderId });
    if (!deleted) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json({ ok: true, deleted });
  } catch (e) {
    console.error("DELETE /inventory error", e);
    res.status(500).json({ error: e.message });
  }
});


// =======================
// Remove a single bin+row location
// POST /api/ct/inventory/remove-location
// body: { cardTraderId, binId, row }
// =======================
router.post("/inventory/remove-location", async (req, res) => {
  try {
    const { cardTraderId, binId, row } = req.body;

    if (!cardTraderId || !binId || !row) {
      return res
        .status(400)
        .json({ error: "cardTraderId, binId, and row are required" });
    }

    const inv = await InventoryItem.findOne({ cardTraderId });
    if (!inv) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    // remove matching location
    inv.locations = (inv.locations || []).filter(
      (loc) =>
        String(loc.bin) !== String(binId) ||
        Number(loc.row) !== Number(row)
    );

    // recalc totalQuantity from locations
    const newTotal = inv.locations.reduce(
      (sum, loc) => sum + (Number(loc.quantity) || 0),
      0
    );
    inv.totalQuantity = newTotal;

    await inv.save();

    res.json({ ok: true, updated: inv });
  } catch (err) {
    console.error("remove-location error", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
