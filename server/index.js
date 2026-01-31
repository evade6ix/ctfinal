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
import orderAllocationsRouter from "./routes/orderAllocations.js"; // ✅


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

// ===================================================================
// AUTO-ALLOCATE / DEDUCT BINS FROM NEW ORDERS (CardTrader Zero)
// Calls POST /api/orders/sync which triggers the same allocation logic
// your UI uses (order-articles), but automatically.
// ===================================================================

async function triggerSyncOrders() {
  try {
    console.log("🔁 [ORDERS] Running POST /api/orders/sync ...");

    const res = await fetch(`http://localhost:${PORT}/api/orders/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const raw = await res.text();
    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {
      // not JSON, ignore
    }

    if (!res.ok) {
      console.error("❌ [ORDERS] sync failed", {
        status: res.status,
        raw,
      });
      return;
    }

    console.log("✅ [ORDERS] sync complete", data || raw);
  } catch (err) {
    console.error("❌ [ORDERS] sync error:", err?.message || err);
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

      // Run once on startup
      triggerSyncOrders();

      // Near real-time polling (safe due to OrderAllocation idempotency)
      const ONE_MINUTE = 60 * 1000;
      setInterval(triggerSyncOrders, ONE_MINUTE);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
