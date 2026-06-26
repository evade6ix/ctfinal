import express from "express";

import {
  testManaPoolConnection,
  getSellerOrders,
  getSellerOrderById,
} from "../services/manapoolClient.js";

import { reconcileManaPoolOrder } from "../services/manapoolOrderReconcile.js";

const router = express.Router();

function unwrapManaPoolOrder(data) {
  return (
    data?.order ||
    data?.data?.order ||
    data?.data ||
    data?.seller_order ||
    data
  );
}

// GET /api/manapool/test
// Simple test to confirm Mana Pool credentials work
router.get("/test", async (req, res) => {
  try {
    const data = await testManaPoolConnection();

    res.json({
      success: true,
      message: "Mana Pool API connection successful",
      data,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Mana Pool API connection failed",
      error: error.response?.data || error.message,
    });
  }
});

// GET /api/manapool/orders
// Pull seller orders from Mana Pool
router.get("/orders", async (req, res) => {
  try {
    const data = await getSellerOrders(req.query);

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch Mana Pool orders",
      error: error.response?.data || error.message,
    });
  }
});

// GET /api/manapool/orders/:orderId
// Pull one Mana Pool order by ID
router.get("/orders/:orderId", async (req, res) => {
  try {
    const data = await getSellerOrderById(req.params.orderId);

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch Mana Pool order",
      error: error.response?.data || error.message,
    });
  }
});

// POST /api/manapool/reconcile-dry-run-body
// Safe local test route. Accepts a fake/raw ManaPool order body.
// Does NOT deduct Mongo inventory.
// Does NOT create OrderAllocation records.
// Does NOT update CardTrader.
router.post("/reconcile-dry-run-body", async (req, res) => {
  try {
    const order =
      req.body?.order ||
      req.body?.data?.order ||
      req.body?.data ||
      req.body;

    const result = await reconcileManaPoolOrder(order, {
      dryRun: true,
      livePush: false,
    });

    res.json({
      success: true,
      dryRun: true,
      result,
    });
  } catch (error) {
    console.error("❌ Failed to dry-run reconcile ManaPool body", {
      error: error.response?.data || error.message || error,
    });

    res.status(error.response?.status || 500).json({
      success: false,
      dryRun: true,
      message: "Failed to dry-run reconcile ManaPool body",
      error: error.response?.data || error.message,
    });
  }
});

// POST /api/manapool/orders/:orderId/reconcile-dry-run
// Safe test route. Fetches one ManaPool order and checks what would happen.
// Does NOT deduct Mongo inventory.
// Does NOT create OrderAllocation records.
// Does NOT update CardTrader.
router.post("/orders/:orderId/reconcile-dry-run", async (req, res) => {
  try {
    const data = await getSellerOrderById(req.params.orderId);
    const order = unwrapManaPoolOrder(data);

    const result = await reconcileManaPoolOrder(order, {
      dryRun: true,
      livePush: false,
    });

    res.json({
      success: true,
      dryRun: true,
      result,
    });
  } catch (error) {
    console.error("❌ Failed to dry-run reconcile ManaPool order", {
      orderId: req.params.orderId,
      error: error.response?.data || error.message || error,
    });

    res.status(error.response?.status || 500).json({
      success: false,
      dryRun: true,
      message: "Failed to dry-run reconcile ManaPool order",
      error: error.response?.data || error.message,
    });
  }
});

// POST /api/manapool/orders/:orderId/reconcile
// Manually reconcile ONE ManaPool order into Mongo/bin allocations.
// This deducts local inventory and pushes the new quantity to CardTrader.
router.post("/orders/:orderId/reconcile", async (req, res) => {
  try {
    const data = await getSellerOrderById(req.params.orderId);
    const order = unwrapManaPoolOrder(data);

    const result = await reconcileManaPoolOrder(order, {
      dryRun: false,
      livePush: req.body?.livePush !== false,
    });

    res.json({
      success: true,
      dryRun: false,
      result,
    });
  } catch (error) {
    console.error("❌ Failed to reconcile ManaPool order", {
      orderId: req.params.orderId,
      error: error.response?.data || error.message || error,
    });

    res.status(error.response?.status || 500).json({
      success: false,
      dryRun: false,
      message: "Failed to reconcile ManaPool order",
      error: error.response?.data || error.message,
    });
  }
});

export default router;