// server/lib/ctOrderLog.js
import { ChangeLog } from "../models/ChangeLog.js";

/**
 * Check if CT order was already processed.
 * @param {number} orderId
 * @returns {Promise<boolean>}
 */
export async function hasProcessedCtOrder(orderId) {
  if (!orderId) return false;

  const existing = await ChangeLog.findOne({
    type: "order-applied",
    orderId,
  }).lean();

  return !!existing;
}

/**
 * Mark a CT order as processed so we don't double-subtract inventory.
 * @param {number} orderId
 * @param {object} details - Optional snapshot for debugging.
 */
export async function markOrderAsProcessed(orderId, details = {}) {
  if (!orderId) return;

  await ChangeLog.create({
    type: "order-applied",
    source: "cardtrader",
    message: `Applied CardTrader order #${orderId}`,
    orderId,
    details,
  });
}
