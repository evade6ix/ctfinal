// server/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";

// Routers
import binsRouter from "./routes/bins.js";
import inventoryRouter from "./routes/inventory.js";
import cardtraderRouter from "./routes/cardtrader.js";
import ordersRouter from "./routes/orders.js";
import orderArticlesRouter from "./routes/orderArticles.js";
import changelogRouter from "./routes/changelog.js";
import catalogRouter from "./routes/catalog.js";
import weeklyOrdersRouter from "./routes/orders-weekly.js";
import orderAllocationsRouter from "./routes/orderAllocations.js";
import manapoolRouter from "./routes/manapool.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());
app.use(compression());

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// API routes
app.use("/api/bins", binsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/ct", cardtraderRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/order-articles", orderArticlesRouter);
app.use("/api/changelog", changelogRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/orders-weekly", weeklyOrdersRouter);
app.use("/api/order-allocations", orderAllocationsRouter);

// Mana Pool routes
app.use("/api/manapool", manapoolRouter);

// ===================================================================
// ORDER SYNC DISABLED ON STARTUP
// ===================================================================
// Do NOT auto-run /api/orders/sync on server start.
// Do NOT poll CardTrader orders automatically.
// This prevents old open CardTrader orders from being allocated against
// newly rebuilt Mongo inventory after a wipe/reset.
//
// To sync orders manually later, run:
// POST http://localhost:3000/api/orders/sync
//
// Mana Pool sync will also be manual until we intentionally add polling.
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
      console.log("⚠️ Order auto-sync is DISABLED. No allocations will run on startup.");
      console.log("✅ Mana Pool routes mounted at /api/manapool");
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();