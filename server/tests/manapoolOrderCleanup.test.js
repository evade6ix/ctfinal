import test from "node:test";
import assert from "node:assert/strict";

import {
  getManaPoolOrderId,
  getManaPoolOrderStatus,
  isShippedManaPoolOrder,
  normalizeManaPoolStatus,
} from "../services/manapoolOrderCleanup.js";

test("normalizes marketplace statuses consistently", () => {
  assert.equal(normalizeManaPoolStatus("  In-Transit "), "in_transit");
  assert.equal(normalizeManaPoolStatus("DELIVERED"), "delivered");
  assert.equal(normalizeManaPoolStatus(null), "");
});

test("recognizes every terminal shipped status", () => {
  for (const status of ["shipped", "sent", "fulfilled", "delivered"]) {
    assert.equal(isShippedManaPoolOrder({ status }), true, status);
  }

  assert.equal(isShippedManaPoolOrder({ status: "paid" }), false);
  assert.equal(isShippedManaPoolOrder({ status: "refunded" }), false);
});

test("prefers the latest fulfillment status and normalizes order IDs", () => {
  const order = {
    id: 12345,
    status: "paid",
    latest_fulfillment_status: "Shipped",
  };

  assert.equal(getManaPoolOrderStatus(order), "shipped");
  assert.equal(getManaPoolOrderId(order), "12345");
});
