// server/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
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
import ordersRouter from "./routes/orders.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());

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
app.use("/api/orders", ordersRouter);

// ===================================================================
// AUTO-SYNC CARDTRADER ORDERS EVERY 5 MINUTES
// ===================================================================

async function triggerSyncOrders() {
  try {
    console.log("🔁 [CT] Running /api/ct/sync-orders ...");

    const res = await fetch(`http://localhost:${PORT}/api/ct/sync-orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const raw = await res.text();
    let data = null;

    // Try parsing JSON if it's JSON
    try {
      data = JSON.parse(raw);
    } catch {
      // ignore — plain text response
    }

    if (!res.ok) {
      console.error("❌ [CT] sync-orders failed", {
        status: res.status,
        raw,
      });
      return;
    }

    console.log("✅ [CT] sync-orders complete", {
      fetchedOrders: data?.fetchedOrders,
      appliedLines: data?.appliedLines,
    });
  } catch (err) {
    console.error("❌ [CT] sync-orders error:", err?.message || err);
  }
}

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

      // 1️⃣ Run once immediately on startup
      triggerSyncOrders();

      // 2️⃣ Then every 5 minutes
      const FIVE_MINUTES = 5 * 60 * 1000;
      setInterval(triggerSyncOrders, FIVE_MINUTES);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
