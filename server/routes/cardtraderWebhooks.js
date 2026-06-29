// server/routes/cardtraderWebhooks.js
import express from "express";

const router = express.Router();

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];

  if (raw == null || raw === "") return defaultValue;

  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function safeHeadersForLog(req) {
  return {
    "content-type": req.get("content-type") || null,
    "user-agent": req.get("user-agent") || null,

    // We only log whether these exist, not their values.
    hasSignature: !!req.get("signature"),
    hasXCardTraderSignature: !!req.get("x-cardtrader-signature"),
    hasXSignature: !!req.get("x-signature"),
  };
}

function safePayloadPreview(payload) {
  return {
    id: payload?.id || null,
    time: payload?.time || null,
    cause: payload?.cause || null,
    objectClass: payload?.object_class || null,
    objectId: payload?.object_id || null,
    mode: payload?.mode || null,

    orderId: payload?.data?.id || null,
    orderState: payload?.data?.state || null,
    viaCardTraderZero: !!payload?.data?.via_cardtrader_zero,
    orderItemsCount: Array.isArray(payload?.data?.order_items)
      ? payload.data.order_items.length
      : null,
  };
}

/**
 * POST /api/ct/webhooks/order
 *
 * STEP 4 SAFE MODE:
 * - Receives CardTrader webhooks
 * - Logs basic info
 * - Does NOT deduct inventory
 * - Does NOT update ManaPool
 *
 * Later step:
 * - We will add signature verification
 * - Then we will call the existing safe reconcile logic
 */
router.post("/order", async (req, res) => {
  const payload = req.body || {};
  const enabled = boolEnv("CARDTRADER_WEBHOOKS_ENABLED", false);

  console.log("🧪 [CardTrader Webhook] Received", {
    enabled,
    headers: safeHeadersForLog(req),
    payload: safePayloadPreview(payload),
  });

  // Only accept Order webhooks for now.
  if (payload?.object_class !== "Order") {
    return res.json({
      ok: true,
      skipped: true,
      reason: "not_order_webhook",
      objectClass: payload?.object_class || null,
      cause: payload?.cause || null,
    });
  }

  // Only log order.create and order.update for now.
  if (payload?.cause !== "order.create" && payload?.cause !== "order.update") {
    return res.json({
      ok: true,
      skipped: true,
      reason: "unsupported_cause_for_step_4",
      cause: payload?.cause || null,
    });
  }

  // Safety switch. This should be false right now.
  if (!enabled) {
    return res.json({
      ok: true,
      received: true,
      disabled: true,
      message:
        "CardTrader webhook received in safe log-only mode. No inventory was changed.",
    });
  }

  // Extra safety: even if someone accidentally turns the env var on,
  // Step 4 still does not process inventory yet.
  return res.status(409).json({
    ok: false,
    received: true,
    disabled: false,
    error:
      "CARDTRADER_WEBHOOKS_ENABLED is true, but live processing is not implemented in Step 4.",
  });
});

export default router;