import { OrderAllocation } from "../models/OrderAllocation.js";

const SHIPPED_STATUSES = new Set([
  "shipped",
  "sent",
  "fulfilled",
  "delivered",
]);

export function normalizeManaPoolStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function getManaPoolOrderStatus(order) {
  return normalizeManaPoolStatus(
    order?.latest_fulfillment_status ||
      order?.fulfillment_status ||
      order?.status ||
      order?.state
  );
}

export function isShippedManaPoolOrder(order) {
  return SHIPPED_STATUSES.has(getManaPoolOrderStatus(order));
}

export function getManaPoolOrderId(order) {
  const raw =
    order?.id ??
    order?.order_id ??
    order?.number ??
    order?.code ??
    order?.uuid ??
    null;

  return raw == null ? null : String(raw);
}

export async function deleteShippedManaPoolOrderAllocations(order) {
  if (!isShippedManaPoolOrder(order)) {
    return { deletedCount: 0, orderId: getManaPoolOrderId(order) };
  }

  const orderId = getManaPoolOrderId(order);
  if (!orderId) return { deletedCount: 0, orderId: null };

  const result = await OrderAllocation.deleteMany({
    source: "manapool",
    orderId,
  });

  if (result.deletedCount > 0) {
    console.log("[MANAPOOL] Removed shipped order allocations", {
      orderId,
      status: getManaPoolOrderStatus(order),
      deletedCount: result.deletedCount,
    });
  }

  return { deletedCount: result.deletedCount, orderId };
}

export async function deleteShippedManaPoolOrdersAllocations(orders = []) {
  const shippedOrders = orders.filter(isShippedManaPoolOrder);
  const orderIds = shippedOrders.map(getManaPoolOrderId).filter(Boolean);

  if (orderIds.length === 0) {
    return { deletedCount: 0, orderIds: [] };
  }

  const result = await OrderAllocation.deleteMany({
    source: "manapool",
    orderId: { $in: orderIds },
  });

  if (result.deletedCount > 0) {
    console.log("[MANAPOOL] Removed shipped order allocations", {
      orderIds,
      deletedCount: result.deletedCount,
    });
  }

  return { deletedCount: result.deletedCount, orderIds };
}
