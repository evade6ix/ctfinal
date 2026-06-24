import express from "express";

import {
  testManaPoolConnection,
  getSellerOrders,
  getSellerOrderById,
} from "../services/manapoolClient.js";

const router = express.Router();

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

export default router;