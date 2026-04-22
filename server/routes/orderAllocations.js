// server/routes/orderAllocations.js
import express from "express";
import { OrderAllocation } from "../models/OrderAllocation.js";
import { ct } from "../ctClient.js";
const router = express.Router();

/**
 * GET /api/order-allocations/by-order/:orderId
 * Returns all allocations for a given orderId.
 */
router.get("/by-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const docs = await OrderAllocation.find({
      orderId: String(orderId),
    }).lean();

    return res.json(docs || []);
  } catch (err) {
    console.error("❌ Error in GET /api/order-allocations/by-order:", err);
    res.status(500).json({ error: "Failed to load allocations for order" });
  }
});

/**
 * PATCH /api/order-allocations/pick
 * Body: { orderId: string | number, cardTraderId: number, pickedBy?: string }
 */
router.patch("/pick", async (req, res) => {
  try {
    const { orderId, cardTraderId, pickedBy } = req.body || {};

    if (!orderId || typeof cardTraderId === "undefined") {
      return res
        .status(400)
        .json({ error: "orderId and cardTraderId are required" });
    }

    const filter = {
      orderId: String(orderId),
      cardTraderId: Number(cardTraderId),
    };

    const update = {
      picked: true,
      pickedAt: new Date(),
    };

    if (pickedBy && typeof pickedBy === "string") {
      update.pickedBy = pickedBy;
    }

    const doc = await OrderAllocation.findOneAndUpdate(filter, update, {
      new: true,
    });

    if (!doc) {
      return res.status(404).json({
        error: "Allocation not found for given orderId + cardTraderId",
      });
    }

    res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/pick:", err);
    res.status(500).json({ error: "Failed to mark allocation as picked" });
  }
});

/**
 * PATCH /api/order-allocations/unpick
 * Body: { orderId: string | number, cardTraderId: number }
 */
router.patch("/unpick", async (req, res) => {
  try {
    const { orderId, cardTraderId } = req.body || {};

    if (!orderId || typeof cardTraderId === "undefined") {
      return res
        .status(400)
        .json({ error: "orderId and cardTraderId are required" });
    }

    const filter = {
      orderId: String(orderId),
      cardTraderId: Number(cardTraderId),
    };

    const update = {
      picked: false,
      pickedAt: null,
      pickedBy: null,
    };

    const doc = await OrderAllocation.findOneAndUpdate(filter, update, {
      new: true,
    });

    if (!doc) {
      return res.status(404).json({
        error: "Allocation not found for given orderId + cardTraderId",
      });
    }

    res.json(doc);
  } catch (err) {
    console.error("❌ Error in PATCH /api/order-allocations/unpick:", err);
    res.status(500).json({ error: "Failed to clear picked state" });
  }
});

/**
 * POST /api/order-allocations/cleanup-stale
 *
 * New strategy:
 *  1) Ask CardTrader for ALL seller orders with state = "paid".
 *  2) Build a set of those order IDs.
 *  3) Delete any OrderAllocation whose orderId is NOT in that set.
 *
 * This matches the UI: you only care about allocations
 * for orders that are currently PAID (i.e. Zero picking pool).
 */
router.post("/cleanup-stale", async (req, res) => {
  try {
    const client = ct();

    // 1️⃣ Pull ALL currently-paid CT orders (paged)
    const paidOrderIds = new Set();
    let page = 1;
    const limit = 50;

    // We keep paginating until CardTrader stops giving us results.
    // If you want to be extra safe, you can cap the pages.
    while (true) {
      const r = await client.get("/orders", {
        params: {
          order_as: "seller",
          sort: "date.desc",
          page,
          limit,
          state: "paid", // important: only currently PAID
        },
      });

      const batch = Array.isArray(r.data) ? r.data : [];
      if (!batch.length) break;

      for (const o of batch) {
        if (o && typeof o.id !== "undefined") {
          paidOrderIds.add(String(o.id));
        }
      }

      if (batch.length < limit) break;
      page++;
    }

    const paidIdArray = Array.from(paidOrderIds);

    // 2️⃣ Delete any allocations whose orderId is NOT in the "currently paid" set
    const deleteFilter =
      paidIdArray.length > 0
        ? { orderId: { $nin: paidIdArray } }
        : {}; // if no paid orders at all, nuke everything

    const result = await OrderAllocation.deleteMany(deleteFilter);

    return res.json({
      paidOrdersKept: paidIdArray.length,
      deletedAllocations: result.deletedCount || 0,
    });
  } catch (err) {
    console.error("❌ Error in POST /api/order-allocations/cleanup-stale:", err);
    return res
      .status(500)
      .json({ error: "Failed to cleanup stale order allocations" });
  }
});
/**
 * POST /api/order-allocations/rebuild-order/:orderId
 *
 * Re-runs allocation reconciliation for a single order by calling
 * the existing /api/order-articles/:orderId route.
 *
 * Safe with current logic because:
 * - existing allocations are checked per line
 * - missing allocations can now be upserted
 */
router.post("/rebuild-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const url = `http://localhost:${process.env.PORT || 3000}/api/order-articles/${orderId}`;
    console.log(`🔁 [ORDER-ALLOCATIONS] Rebuilding allocations for order ${orderId} via ${url}`);

    const resp = await fetch(url);
    const raw = await resp.text().catch(() => "");

    if (!resp.ok) {
      console.error(
        "❌ Failed to rebuild order allocations",
        orderId,
        resp.status,
        raw.slice(0, 500)
      );

      return res.status(500).json({
        ok: false,
        error: "Failed to rebuild order allocations",
        status: resp.status,
        details: raw.slice(0, 500),
      });
    }

    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    const allocationCount = await OrderAllocation.countDocuments({
      orderId: String(orderId),
    });

    return res.json({
      ok: true,
      orderId: String(orderId),
      allocationCount,
      resultCount: Array.isArray(parsed) ? parsed.length : null,
    });
  } catch (err) {
    console.error("❌ Error in POST /api/order-allocations/rebuild-order:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to rebuild order allocations",
      details: err.message,
    });
  }
});
export default router;


