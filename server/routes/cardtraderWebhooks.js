// server/routes/cardtraderWebhooks.js
import crypto from "crypto";
import express from "express";
import { syncCardTraderWebhookOrder } from "./orders.js";

const router = express.Router();

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];

  if (raw == null || raw === "") return defaultValue;

  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function safeJsonPreview(value) {
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value).slice(0, 1000);
  }
}

function timingSafeEqualString(a, b) {
  const aBuffer = Buffer.from(String(a || ""));
  const bBuffer = Buffer.from(String(b || ""));

  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function verifyCardTraderSignature(req) {
  const secret = process.env.CARDTRADER_WEBHOOK_SECRET;
  const signature = req.get("Signature");
  const rawBody = req.rawBody;

  if (!secret) {
    return {
      ok: false,
      reason: "missing_CARDTRADER_WEBHOOK_SECRET",
    };
  }

  if (!signature) {
    return {
      ok: false,
      reason: "missing_Signature_header",
    };
  }

  if (!rawBody) {
    return {
      ok: false,
      reason: "missing_raw_body_for_signature_verification",
    };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return {
    ok: timingSafeEqualString(expected, signature),
    reason: "signature_mismatch",
    expectedLength: expected.length,
    receivedLength: String(signature).length,
  };
}

function shouldProcessCardTraderWebhook(payload) {
  const cause = String(payload?.cause || "");
  const objectClass = String(payload?.object_class || "");

  if (objectClass !== "Order") {
    return {
      ok: false,
      reason: "not_order_webhook",
      objectClass,
      cause,
    };
  }

  if (cause !== "order.create" && cause !== "order.update") {
    return {
      ok: false,
      reason: "unsupported_cause",
      objectClass,
      cause,
    };
  }

  if (!payload?.data || typeof payload.data !== "object") {
    return {
      ok: false,
      reason: "missing_order_data",
      objectClass,
      cause,
    };
  }

  return {
    ok: true,
    cause,
    objectClass,
  };
}

/**
 * POST /api/ct/webhooks/order
 *
 * CardTrader signs the raw JSON body using HMAC-SHA256 + the app shared_secret
 * and sends it in the Signature header.
 *
 * Safety switch:
 * CARDTRADER_WEBHOOKS_ENABLED=false means verify/log/ack only, no inventory changes.
 */
router.post("/order", async (req, res) => {
  const startedAt = new Date();
  const payload = req.body || {};

  try {
    const signatureCheck = verifyCardTraderSignature(req);

    if (!signatureCheck.ok) {
      console.warn("⚠️ [CardTrader Webhook] Invalid signature", {
        reason: signatureCheck.reason,
        expectedLength: signatureCheck.expectedLength,
        receivedLength: signatureCheck.receivedLength,
        payloadPreview: safeJsonPreview(payload),
      });

      return res.status(401).json({
        ok: false,
        error: "invalid_cardtrader_webhook_signature",
        reason: signatureCheck.reason,
      });
    }

    const processCheck = shouldProcessCardTraderWebhook(payload);

    if (!processCheck.ok) {
      console.log("ℹ️ [CardTrader Webhook] Ignored webhook", {
        ...processCheck,
        id: payload?.id || null,
        objectId: payload?.object_id || null,
        mode: payload?.mode || null,
      });

      return res.json({
        ok: true,
        skipped: true,
        ...processCheck,
      });
    }

    const enabled = boolEnv("CARDTRADER_WEBHOOKS_ENABLED", false);

    if (!enabled) {
      console.log("🧪 [CardTrader Webhook] Verified but disabled", {
        id: payload?.id || null,
        cause: payload?.cause || null,
        objectId: payload?.object_id || null,
        mode: payload?.mode || null,
        orderState: payload?.data?.state || null,
        viaCardTraderZero: !!payload?.data?.via_cardtrader_zero,
      });

      return res.json({
        ok: true,
        verified: true,
        disabled: true,
        message:
          "CardTrader webhook verified. Set CARDTRADER_WEBHOOKS_ENABLED=true to reconcile orders.",
      });
    }

    const result = await syncCardTraderWebhookOrder(payload.data);

    console.log("✅ [CardTrader Webhook] Processed", {
      id: payload?.id || null,
      cause: payload?.cause || null,
      objectId: payload?.object_id || null,
      mode: payload?.mode || null,
      durationMs: Date.now() - startedAt.getTime(),
      result,
    });

    return res.json({
      ok: true,
      verified: true,
      processed: true,
      result,
    });
  } catch (err) {
    console.error("❌ [CardTrader Webhook] Failed", {
      error: err?.response?.data || err?.message || err,
      payloadPreview: safeJsonPreview(payload),
    });

    return res.status(500).json({
      ok: false,
      error: "cardtrader_webhook_failed",
      details: err?.message || String(err),
    });
  }
});

export default router;
