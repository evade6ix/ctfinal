import { useEffect, useMemo, useState } from "react";

import type { OrderAllocation, OrderDetails, OrderItem, OrderSummary, ShippingAddress } from "./types";
import {
  allocationToBinLocations,
  formatShippingAddress,
  getManaPoolInventoryId,
  getManaPoolMarketplaceOrderItemId,
  getManaPoolNumericOrderItemId,
  isShippedManaPoolStatus,
  loadHiddenRefundedOrderIds,
  normalizeShippingAddress,
  persistHiddenRefundedOrderIds,
} from "./utils";

export function useManaPoolOrders() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | number | null>(null);
  const [itemsByOrder, setItemsByOrder] = useState<Record<string | number, OrderItem[]>>({});
  const [detailsByOrder, setDetailsByOrder] = useState<Record<string | number, OrderDetails>>({});
  const [loadingOrderId, setLoadingOrderId] = useState<string | number | null>(null);
  const [viewMode, setViewMode] = useState<"orders" | "daily">("orders");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pickedMap, setPickedMap] = useState<Record<string | number, Record<string | number, boolean>>>({});
  const [fulfillmentAction, setFulfillmentAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hiddenRefundedOrderIds, setHiddenRefundedOrderIds] = useState<Set<string>>(
    () => loadHiddenRefundedOrderIds()
  );

  const visibleOrders = useMemo(
    () => orders.filter((order) => !hiddenRefundedOrderIds.has(String(order.id))),
    [orders, hiddenRefundedOrderIds]
  );

  const selectedOrder = useMemo(
    () => orders.find((order) => String(order.id) === String(selectedOrderId)) || null,
    [orders, selectedOrderId]
  );

  const fetchOrders = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/manapool/orders?limit=50");
      if (!res.ok) throw new Error("Failed to load Mana Pool orders");
      const payload = await res.json();
      const manaPoolOrders = payload?.data?.orders || [];

      const normalizedOrders: OrderSummary[] = manaPoolOrders
        .map((order: any) => {
          const items = Array.isArray(order.items)
            ? order.items
            : Array.isArray(order.line_items)
            ? order.line_items
            : Array.isArray(order.order_items)
            ? order.order_items
            : Array.isArray(order.lines)
            ? order.lines
            : [];
          const buyerName =
            order.buyer?.username ||
            order.buyer?.name ||
            order.customer?.name ||
            order.customer_name ||
            order.shipping_address?.name ||
            order.shippingAddress?.name ||
            "Unknown";
          const buyerCountry =
            order.buyer?.country ||
            order.customer?.country ||
            order.shipping_address?.country ||
            order.shippingAddress?.country ||
            "";
          const status =
            order.latest_fulfillment_status ||
            order.fulfillment_status ||
            order.status ||
            order.state ||
            (Array.isArray(order.fulfillments) && order.fulfillments.length > 0
              ? "fulfilled"
              : "unfulfilled");

          return {
            id: order.id,
            code: order.label || order.number || order.code || String(order.id),
            state: status,
            orderAs: "Mana Pool",
            buyer: { username: buyerName, country: buyerCountry },
            size:
              order.items_count ||
              order.line_items_count ||
              order.quantity ||
              items.reduce(
                (sum: number, item: any) => sum + Number(item.quantity || item.qty || 1),
                0
              ),
            createdAt: order.created_at || order.createdAt || order.inserted_at || null,
            sellerTotalCents:
              order.seller_total_cents ??
              order.payment?.total_cents ??
              order.total_cents ??
              order.subtotal_cents ??
              null,
            sellerTotalCurrency: order.seller_total_currency || order.currency || "USD",
            formattedTotal: order.formatted_total || order.total_formatted || null,
            allocated: false,
          };
        })
        .filter((order: OrderSummary) => !isShippedManaPoolStatus(order.state));

      setOrders(normalizedOrders);
      setSelectedOrderId((current) => {
        if (current == null) return null;
        return normalizedOrders.some((order) => String(order.id) === String(current))
          ? current
          : null;
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to load Mana Pool orders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const loadItems = async (orderId: string | number, force = false) => {
    if (!force && itemsByOrder[orderId] && detailsByOrder[orderId]) return;
    try {
      setLoadingOrderId(orderId);
      setActionError(null);
      const [orderRes, allocationRes] = await Promise.all([
        fetch(`/api/manapool/orders/${encodeURIComponent(String(orderId))}`),
        fetch(`/api/order-allocations/by-order/${encodeURIComponent(String(orderId))}?source=manapool`),
      ]);
      if (!orderRes.ok) {
        throw new Error(`Failed to load Mana Pool order items: ${orderRes.status}`);
      }

      const payload = await orderRes.json();
      const order = payload?.data?.order || payload?.data || payload;
      const rawItems =
        order?.items ||
        order?.line_items ||
        order?.order_items ||
        order?.lines ||
        order?.order_lines ||
        order?.seller_order_items ||
        order?.articles ||
        [];
      const rawItemsArray = Array.isArray(rawItems) ? rawItems : [];
      const detailedStatus =
        order?.latest_fulfillment_status ||
        order?.fulfillment_status ||
        order?.status ||
        order?.state ||
        null;
      const buyerName =
        order?.buyer?.username ||
        order?.buyer?.name ||
        order?.customer?.name ||
        order?.customer_name ||
        order?.shipping_address?.name ||
        order?.shippingAddress?.name ||
        "Unknown";
      const buyerCountry =
        order?.buyer?.country ||
        order?.customer?.country ||
        order?.shipping_address?.country ||
        order?.shippingAddress?.country ||
        "";
      const detailedItemCount = rawItemsArray.reduce(
        (sum: number, item: any) => sum + Number(item.quantity || item.qty || 1),
        0
      );

      setOrders((previous) =>
        previous.map((existing) =>
          String(existing.id) === String(orderId)
            ? {
                ...existing,
                state: detailedStatus || existing.state,
                buyer: { username: buyerName, country: buyerCountry },
                size: detailedItemCount,
                sellerTotalCents:
                  order?.payment?.total_cents ??
                  order?.total_cents ??
                  existing.sellerTotalCents ??
                  null,
                sellerTotalCurrency:
                  order?.seller_total_currency ||
                  order?.currency ||
                  existing.sellerTotalCurrency ||
                  "USD",
              }
            : existing
        )
      );
      setDetailsByOrder((previous) => ({
        ...previous,
        [orderId]: {
          shippingAddress: normalizeShippingAddress(order),
          status: detailedStatus,
          shippingMethod:
            order?.shipping_method || order?.shippingMethod || order?.shipping?.method || null,
        },
      }));

      const allocations: OrderAllocation[] = allocationRes.ok ? await allocationRes.json() : [];
      const byOrderItemId = new Map<number, OrderAllocation>();
      const byMarketplaceId = new Map<string, OrderAllocation>();
      const byInventoryId = new Map<string, OrderAllocation>();
      for (const allocation of allocations || []) {
        if (typeof allocation.orderItemId === "number") {
          byOrderItemId.set(allocation.orderItemId, allocation);
        }
        if (allocation.marketplaceOrderItemId) {
          byMarketplaceId.set(String(allocation.marketplaceOrderItemId), allocation);
        }
        if (allocation.manapoolInventoryId) {
          byInventoryId.set(String(allocation.manapoolInventoryId), allocation);
        }
      }

      const normalizedItems: OrderItem[] = rawItemsArray.map((item: any, index: number) => {
        const numericOrderItemId = getManaPoolNumericOrderItemId(item, index);
        const marketplaceOrderItemId = getManaPoolMarketplaceOrderItemId(item, index);
        const manapoolInventoryId = getManaPoolInventoryId(item);
        const allocation =
          byOrderItemId.get(numericOrderItemId) ||
          byMarketplaceId.get(marketplaceOrderItemId) ||
          (manapoolInventoryId ? byInventoryId.get(manapoolInventoryId) : null) ||
          null;
        const single = item?.product?.single || {};
        const rawSetCode =
          allocation?.setCode ||
          allocation?.inventoryItem?.setCode ||
          single?.set ||
          item.setCode ||
          item.set_code ||
          item.expansion_code ||
          null;
        const setCode =
          typeof rawSetCode === "string" && rawSetCode.trim()
            ? rawSetCode.trim().toUpperCase()
            : null;
        const collectorNumber = single?.number || item.collector_number || item.number || null;
        const setDisplay = setCode
          ? collectorNumber
            ? `${setCode} #${collectorNumber}`
            : setCode
          : item.set_name ||
            item.setName ||
            item.expansion_name ||
            item.product?.set_name ||
            item.product?.expansion_name ||
            null;

        return {
          id: numericOrderItemId,
          marketplaceOrderItemId,
          source: "manapool",
          cardTraderId:
            allocation?.cardTraderId ?? allocation?.inventoryItem?.cardTraderId ?? null,
          manapoolInventoryId,
          name:
            allocation?.name ||
            allocation?.inventoryItem?.name ||
            item.name ||
            item.product_name ||
            item.card_name ||
            item.title ||
            item.product?.name ||
            "No name",
          quantity: item.quantity || item.qty || item.count || allocation?.requestedQuantity || 1,
          imageUrl:
            allocation?.inventoryItem?.imageUrl ||
            item.image_url ||
            item.imageUrl ||
            item.product?.image_url ||
            item.product?.imageUrl ||
            null,
          setCode,
          set_name: setDisplay || "Unknown set",
          collectorNumber,
          scryfallId:
            allocation?.scryfallId ||
            allocation?.inventoryItem?.manapool?.scryfallId ||
            allocation?.inventoryItem?.identifiers?.scryfallId ||
            single?.scryfall_id ||
            null,
          tcgplayerSkuId:
            allocation?.tcgplayerSkuId ||
            allocation?.inventoryItem?.identifiers?.tcgplayerSkuId ||
            allocation?.inventoryItem?.manapool?.tcgplayerSku ||
            String(item.tcgsku || item.product?.tcgplayer_sku || "") ||
            null,
          manapoolCustomExternalId:
            allocation?.manapoolCustomExternalId ||
            allocation?.inventoryItem?.manapool?.customExternalId ||
            item.custom_external_id ||
            null,
          condition:
            allocation?.condition ??
            allocation?.inventoryItem?.condition ??
            item.condition ??
            item.condition_name ??
            item.product?.condition ??
            null,
          isFoil:
            allocation?.isFoil ??
            allocation?.inventoryItem?.isFoil ??
            Boolean(
              item.is_foil ||
                item.isFoil ||
                item.foil ||
                item.finish === "foil" ||
                item.product?.is_foil ||
                item.product?.foil
            ),
          picked: !!allocation?.picked,
          pickedAt: allocation?.pickedAt || null,
          pickedBy: allocation?.pickedBy || null,
          binLocations: allocationToBinLocations(allocation),
        };
      });

      setItemsByOrder((previous) => ({ ...previous, [orderId]: normalizedItems }));
      const initialPicked: Record<string | number, boolean> = {};
      for (const item of normalizedItems) {
        const key =
          typeof item.id === "number"
            ? item.id
            : typeof item.cardTraderId === "number"
            ? item.cardTraderId
            : null;
        if (key !== null) initialPicked[key] = !!item.picked;
      }
      setPickedMap((previous) => ({ ...previous, [orderId]: initialPicked }));
    } catch (err: any) {
      console.error("Failed loading Mana Pool order items", err);
      setActionError(err.message || "Failed to load order details");
      setItemsByOrder((previous) => ({ ...previous, [orderId]: [] }));
    } finally {
      setLoadingOrderId((current) =>
        String(current) === String(orderId) ? null : current
      );
    }
  };

  const selectOrder = (orderId: string | number) => {
    setSelectedOrderId(orderId);
    setActionMessage(null);
    setActionError(null);
    loadItems(orderId);
  };

  const closeOrder = () => setSelectedOrderId(null);

  const hideRefundedOrder = (orderId: string | number) => {
    const next = new Set(hiddenRefundedOrderIds);
    next.add(String(orderId));
    setHiddenRefundedOrderIds(next);
    persistHiddenRefundedOrderIds(next);
    if (String(selectedOrderId) === String(orderId)) setSelectedOrderId(null);
  };

  const clearHiddenRefundedOrders = () => {
    const next = new Set<string>();
    setHiddenRefundedOrderIds(next);
    persistHiddenRefundedOrderIds(next);
  };

  const syncOrders = async () => {
    const confirmed = window.confirm(
      "This will run the safe order sync. It can still deduct inventory for NEW exact CardTrader ID matches. Make sure ORDER_SYNC_CUTOFF is set in server/.env before continuing. Continue?"
    );
    if (!confirmed) return;
    try {
      setSyncing(true);
      setSyncMessage(null);
      setSyncError(null);
      const res = await fetch("/api/orders/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to sync orders");
      setSyncMessage(
        `Safe sync complete. Eligible: ${data.eligibleOrders ?? 0}, reconciled: ${
          data.reconciled ?? 0
        }, failed: ${data.failed ?? 0}. Cutoff: ${data.cutoff ?? "none"}`
      );
      await fetchOrders();
    } catch (err: any) {
      console.error("Sync failed:", err);
      setSyncError(err.message || "Failed to sync orders");
    } finally {
      setSyncing(false);
    }
  };

  const togglePicked = async (orderId: string | number, item: OrderItem) => {
    const cardTraderId = item.cardTraderId;
    if (cardTraderId == null) return;
    const pickedKey = typeof item.id === "number" ? item.id : cardTraderId;
    const currentlyPicked = !!pickedMap[orderId]?.[pickedKey];
    const nextPicked = !currentlyPicked;
    try {
      const endpoint = nextPicked ? "pick" : "unpick";
      const res = await fetch(`/api/order-allocations/${endpoint}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          orderItemId: item.id,
          cardTraderId,
          pickedBy: "manual",
          source: "manapool",
        }),
      });
      if (!res.ok) throw new Error(`Failed to ${endpoint} allocation`);
      setPickedMap((previous) => ({
        ...previous,
        [orderId]: { ...previous[orderId], [pickedKey]: nextPicked },
      }));
    } catch (err: any) {
      console.error("Error toggling picked state", err);
      setActionError(err.message || "Failed to update picked state");
    }
  };

  const copyShippingAddress = async (address?: ShippingAddress | null) => {
    const text = formatShippingAddress(address);
    if (!text) {
      setActionError("No shipping address is available for this order.");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setActionError(null);
      setActionMessage("Shipping address copied.");
    } catch (err) {
      console.error("Failed to copy shipping address", err);
      setActionError("Could not copy the shipping address.");
    }
  };

  const setFulfillmentStatus = async (
    orderId: string | number,
    status: "processing" | "shipped"
  ) => {
    if (
      status === "shipped" &&
      !window.confirm("Mark this Mana Pool order as shipped? This updates Mana Pool immediately.")
    ) {
      return;
    }
    try {
      setFulfillmentAction(status);
      setActionMessage(null);
      setActionError(null);
      const res = await fetch(
        `/api/manapool/orders/${encodeURIComponent(String(orderId))}/fulfillment`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.error?.message || data?.message || `Failed to mark order ${status}`
        );
      }
      setOrders((previous) =>
        previous.map((order) =>
          String(order.id) === String(orderId) ? { ...order, state: status } : order
        )
      );
      setDetailsByOrder((previous) => ({
        ...previous,
        [orderId]: { ...previous[orderId], status },
      }));
      if (status === "shipped") {
        setSelectedOrderId(null);
        await fetchOrders();
      } else {
        setActionMessage("Order marked in fulfillment on Mana Pool.");
        await loadItems(orderId, true);
      }
    } catch (err: any) {
      console.error("Failed updating Mana Pool fulfillment", err);
      setActionError(err.message || "Failed to update Mana Pool fulfillment");
    } finally {
      setFulfillmentAction(null);
    }
  };

  return {
    orders,
    visibleOrders,
    selectedOrderId,
    selectedOrder,
    itemsByOrder,
    detailsByOrder,
    loadingOrderId,
    loading,
    error,
    viewMode,
    setViewMode,
    syncing,
    syncMessage,
    syncError,
    pickedMap,
    fulfillmentAction,
    actionMessage,
    actionError,
    hiddenRefundedOrderIds,
    fetchOrders,
    selectOrder,
    closeOrder,
    hideRefundedOrder,
    clearHiddenRefundedOrders,
    syncOrders,
    togglePicked,
    copyShippingAddress,
    setFulfillmentStatus,
  };
}

export type ManaPoolOrdersModel = ReturnType<typeof useManaPoolOrders>;
