// server/services/orderAutoSyncWorker.js
import { getSellerOrders, getSellerOrderById } from "./manapoolClient.js";
import { reconcileManaPoolOrder } from "./manapoolOrderReconcile.js";
import {
  deleteShippedManaPoolOrderAllocations,
  getManaPoolOrderStatus,
  isShippedManaPoolOrder,
} from "./manapoolOrderCleanup.js";
import { startOperationRun, finishOperationRun } from "./operationRuns.js";

let timer = null;
let running = false;
let cycleNumber = 0;

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];

  if (raw == null || raw === "") return defaultValue;

  const value = String(raw).trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function intEnv(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

function getBaseUrl(port) {
  return process.env.INTERNAL_API_BASE_URL || `http://127.0.0.1:${port}`;
}

function unwrapManaPoolOrders(data) {
  if (Array.isArray(data?.orders)) return data.orders;
  if (Array.isArray(data?.data?.orders)) return data.data.orders;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.seller_orders)) return data.seller_orders;
  if (Array.isArray(data)) return data;

  return [];
}

function unwrapManaPoolOrder(data) {
  return (
    data?.order ||
    data?.data?.order ||
    data?.data ||
    data?.seller_order ||
    data
  );
}

function getManaPoolOrderId(order) {
  const raw =
    order?.id ??
    order?.order_id ??
    order?.number ??
    order?.code ??
    order?.uuid ??
    null;

  return raw == null ? null : String(raw);
}

function getOrderCreatedAt(order) {
  return (
    order?.created_at ||
    order?.createdAt ||
    order?.inserted_at ||
    order?.updated_at ||
    order?.updatedAt ||
    order?.date ||
    null
  );
}

function getTorontoStartOfToday() {
  const torontoNow = new Date(
    new Date().toLocaleString("en-CA", {
      timeZone: "America/Toronto",
    })
  );

  torontoNow.setHours(0, 0, 0, 0);
  return torontoNow;
}

function getManaPoolCutoffDate() {
  const raw = process.env.MANAPOOL_ORDER_SYNC_CUTOFF;

  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;

    console.warn("[AUTO-SYNC] Invalid MANAPOOL_ORDER_SYNC_CUTOFF:", raw);
  }

  // Safe default: only process orders from today onward.
  return getTorontoStartOfToday();
}

function isAfterCutoff(order, cutoffDate) {
  const rawCreatedAt = getOrderCreatedAt(order);

  if (!rawCreatedAt) {
    return false;
  }

  const createdAt = new Date(rawCreatedAt);

  if (Number.isNaN(createdAt.getTime())) {
    return false;
  }

  return createdAt >= cutoffDate;
}

function isManaPoolStatusEligible(order) {
  const rawStatus = getManaPoolOrderStatus(order);

  // If ManaPool does not return a status, we allow it because the seller/orders
  // endpoint usually returns actionable seller orders.
  if (!rawStatus) return true;

  const blocked = new Set([
    "cancelled",
    "canceled",
    "refunded",
    "fulfilled",
    "shipped",
    "sent",
    "delivered",
    "complete",
    "completed",
    "closed",
  ]);

  return !blocked.has(rawStatus);
}

async function runCardTraderAutoSync({ baseUrl }) {
  if (!boolEnv("CARDTRADER_AUTO_SYNC_ENABLED", true)) {
    return {
      ok: true,
      skipped: true,
      reason: "CARDTRADER_AUTO_SYNC_ENABLED is false",
    };
  }

  const res = await fetch(`${baseUrl}/api/orders/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CTFinal-Trigger": "auto-worker",
    },
  });

  const raw = await res.text().catch(() => "");
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw: raw.slice(0, 500) };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data,
    };
  }

  return {
    ok: true,
    status: res.status,
    data,
  };
}

async function runManaPoolAutoSync() {
  if (!boolEnv("MANAPOOL_AUTO_SYNC_ENABLED", true)) {
    return {
      ok: true,
      skipped: true,
      reason: "MANAPOOL_AUTO_SYNC_ENABLED is false",
    };
  }

  const limit = intEnv("MANAPOOL_AUTO_SYNC_LIMIT", 50);
  const cutoffDate = getManaPoolCutoffDate();

  const listData = await getSellerOrders({
    limit,
  });

  const orders = unwrapManaPoolOrders(listData);

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;

  const results = [];

  for (const orderSummary of orders) {
    const orderId = getManaPoolOrderId(orderSummary);

    if (!orderId) {
      skipped++;
      results.push({
        ok: false,
        skipped: true,
        reason: "missing_manapool_order_id",
      });
      continue;
    }

    if (!isManaPoolStatusEligible(orderSummary)) {
      const cleanup = isShippedManaPoolOrder(orderSummary)
        ? await deleteShippedManaPoolOrderAllocations(orderSummary)
        : null;

      skipped++;
      results.push({
        orderId,
        ok: true,
        skipped: true,
        reason: "ineligible_status",
        status: getManaPoolOrderStatus(orderSummary) || null,
        cleanup,
      });
      continue;
    }

    if (!isAfterCutoff(orderSummary, cutoffDate)) {
      skipped++;
      results.push({
        orderId,
        ok: true,
        skipped: true,
        reason: "before_cutoff_or_missing_created_at",
        cutoff: cutoffDate.toISOString(),
        createdAt: getOrderCreatedAt(orderSummary),
      });
      continue;
    }

    try {
      const fullOrderData = await getSellerOrderById(orderId);
      const fullOrder = unwrapManaPoolOrder(fullOrderData);

      if (!isManaPoolStatusEligible(fullOrder)) {
        const cleanup = isShippedManaPoolOrder(fullOrder)
          ? await deleteShippedManaPoolOrderAllocations(fullOrder)
          : null;

        skipped++;
        results.push({
          orderId,
          ok: true,
          skipped: true,
          reason: "full_order_ineligible_status",
          status: getManaPoolOrderStatus(fullOrder) || null,
          cleanup,
        });
        continue;
      }

      if (!isAfterCutoff(fullOrder, cutoffDate)) {
        skipped++;
        results.push({
          orderId,
          ok: true,
          skipped: true,
          reason: "full_order_before_cutoff_or_missing_created_at",
          cutoff: cutoffDate.toISOString(),
          createdAt: getOrderCreatedAt(fullOrder),
        });
        continue;
      }

      const result = await reconcileManaPoolOrder(fullOrder, {
        dryRun: false,
        livePush: true,
      });

      reconciled++;

      results.push({
        orderId,
        ok: true,
        result,
      });
    } catch (err) {
      failed++;

      results.push({
        orderId,
        ok: false,
        error: err?.response?.data || err?.message || String(err),
      });
    }
  }

  return {
    ok: failed === 0,
    fetchedOrders: orders.length,
    reconciled,
    skipped,
    failed,
    cutoff: cutoffDate.toISOString(),
    results,
  };
}

async function runAutoSyncCycle({ port, trigger = "interval" }) {
  if (running) {
    console.log("[AUTO-SYNC] Previous sync still running, skipping this cycle.");
    return;
  }

  running = true;
  cycleNumber++;

  const startedAt = new Date();
  const baseUrl = getBaseUrl(port);
  const operation = await startOperationRun({
    kind: "order-sync",
    label: "Marketplace order synchronization",
    source: "marketplaces",
    trigger,
  });

  console.log("[AUTO-SYNC] Starting cycle", {
    cycleNumber,
    trigger,
    startedAt: startedAt.toISOString(),
    baseUrl,
  });

  const summary = {
    cycleNumber,
    trigger,
    startedAt: startedAt.toISOString(),
    cardTrader: null,
    manaPool: null,
  };

  try {
    try {
      summary.cardTrader = await runCardTraderAutoSync({ baseUrl });
    } catch (err) {
      summary.cardTrader = {
        ok: false,
        error: err?.response?.data || err?.message || String(err),
      };
    }

    try {
      summary.manaPool = await runManaPoolAutoSync();
    } catch (err) {
      summary.manaPool = {
        ok: false,
        error: err?.response?.data || err?.message || String(err),
      };
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt.getTime();

    const errors = [summary.cardTrader, summary.manaPool]
      .filter((result) => result && result.ok === false)
      .map((result) => ({ error: result.error || result.data || "Marketplace sync failed" }));

    await finishOperationRun(operation, {
      status: errors.length ? "completed_with_errors" : "completed",
      summary,
      errors,
    });

    console.log("[AUTO-SYNC] Cycle complete", summary);
  } finally {
    running = false;
  }
}

export function startOrderAutoSyncWorker({ port }) {
  const enabled = boolEnv("ORDER_AUTO_SYNC_ENABLED", false);

  if (!enabled) {
    console.log(
      "[AUTO-SYNC] Disabled. Set ORDER_AUTO_SYNC_ENABLED=true to enable polling."
    );
    return null;
  }

  const intervalMs = Math.max(
    30000,
    intEnv("ORDER_AUTO_SYNC_INTERVAL_MS", 60000)
  );

  if (timer) {
    console.log("[AUTO-SYNC] Worker already started.");
    return timer;
  }

  console.log("[AUTO-SYNC] Starting worker", {
    intervalMs,
    cardTraderEnabled: boolEnv("CARDTRADER_AUTO_SYNC_ENABLED", true),
    manaPoolEnabled: boolEnv("MANAPOOL_AUTO_SYNC_ENABLED", true),
  });

  if (boolEnv("ORDER_AUTO_SYNC_RUN_ON_STARTUP", true)) {
    setTimeout(() => {
      runAutoSyncCycle({ port, trigger: "startup" }).catch((err) => {
        console.error("[AUTO-SYNC] Startup cycle failed", err);
      });
    }, 5000);
  }

  timer = setInterval(() => {
    runAutoSyncCycle({ port, trigger: "interval" }).catch((err) => {
      console.error("[AUTO-SYNC] Interval cycle failed", err);
    });
  }, intervalMs);

  return timer;
}

export function stopOrderAutoSyncWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  running = false;
}
