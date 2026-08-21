import express from "express";
import mongoose from "mongoose";

const router = express.Router();

function enabled(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

router.get("/status", (_req, res) => {
  res.json({
    server: {
      node: process.version,
      environment: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.round(process.uptime()),
    },
    database: {
      connected: mongoose.connection.readyState === 1,
      state: ["disconnected", "connected", "connecting", "disconnecting"]?.[
        mongoose.connection.readyState
      ] || "unknown",
    },
    marketplaces: {
      cardTraderConfigured: !!process.env.CARDTRADER_TOKEN,
      manaPoolConfigured: !!(
        process.env.MANAPOOL_EMAIL && process.env.MANAPOOL_ACCESS_TOKEN
      ),
    },
    automation: {
      enabled: enabled("ORDER_AUTO_SYNC_ENABLED", false),
      cardTraderEnabled: enabled("CARDTRADER_AUTO_SYNC_ENABLED", true),
      manaPoolEnabled: enabled("MANAPOOL_AUTO_SYNC_ENABLED", true),
      intervalMs: Number(process.env.ORDER_AUTO_SYNC_INTERVAL_MS || 60000),
      runOnStartup: enabled("ORDER_AUTO_SYNC_RUN_ON_STARTUP", true),
    },
  });
});

export default router;
