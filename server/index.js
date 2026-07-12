// server/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";

// Routers
import binsRouter from "./routes/bins.js";
import inventoryRouter from "./routes/inventory.js";
import cardListDeleteRouter from "./routes/cardListDelete.js";
import cardListRouter from "./routes/cardList.js";
import cardtraderRouter from "./routes/cardtrader.js";
import cardtraderWebhooksRouter from "./routes/cardtraderWebhooks.js";
import cardtraderRepriceRouter from "./routes/cardtraderReprice.js";
import ordersRouter from "./routes/orders.js";
import orderArticlesRouter from "./routes/orderArticles.js";
import changelogRouter from "./routes/changelog.js";
import catalogRouter from "./routes/catalog.js";
import weeklyOrdersRouter from "./routes/orders-weekly.js";
import orderAllocationsRouter from "./routes/orderAllocations.js";
import manapoolRouter from "./routes/manapool.js";
import stagedPushRouter from "./routes/stagedPush.js";

// Auto-sync worker
import { startOrderAutoSyncWorker } from "./services/orderAutoSyncWorker.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);
app.use(compression());

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// API routes
app.use("/api/bins", binsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/card-list", cardListDeleteRouter);
app.use("/api/card-list", cardListRouter);
app.use("/api/ct/webhooks", cardtraderWebhooksRouter);
app.use("/api/ct/reprice", cardtraderRepriceRouter);
app.use("/api/ct", cardtraderRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/order-articles", orderArticlesRouter);
app.use("/api/changelog", changelogRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/orders-weekly", weeklyOrdersRouter);
app.use("/api/order-allocations", orderAllocationsRouter);
app.use("/api/staged-push", stagedPushRouter);

// Mana Pool routes
app.use("/api/manapool", manapoolRouter);

// ===================================================================
// ORDER AUTO-SYNC
// ===================================================================
// Controlled by .env:
//
// ORDER_AUTO_SYNC_ENABLED=true
// ORDER_AUTO_SYNC_INTERVAL_MS=60000
// ORDER_AUTO_SYNC_RUN_ON_STARTUP=true
//
// CARDTRADER_AUTO_SYNC_ENABLED=true
// MANAPOOL_AUTO_SYNC_ENABLED=true
//
// Safety:
// - CardTrader sync uses /api/orders/sync, which only reconciles eligible orders.
// - ManaPool sync uses OrderAllocation dedupe so lines are not deducted twice.
// - Cutoffs prevent old orders from touching rebuilt inventory.
// ===================================================================

// ===================================================================
// DATABASE + SERVER STARTUP
// ===================================================================

async function start() {
  try {
    if (!MONGO_URI) {
      console.error("❌ MONGO_URI missing in .env");
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log("✅ Mana Pool routes mounted at /api/manapool");
      console.log("✅ Staged push routes mounted at /api/staged-push");
      console.log("✅ CardTrader webhook routes mounted at /api/ct/webhooks");
      console.log("✅ CardTrader repricer routes mounted at /api/ct/reprice");
      console.log("✅ Card list route mounted at /api/card-list");

      startOrderAutoSyncWorker({
        port: PORT,
      });
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
