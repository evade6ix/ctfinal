import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  SegmentedControl,
} from "@mantine/core";
import { IconArrowsDownUp, IconTrash } from "@tabler/icons-react";

import { OrdersDailyView } from "./OrdersDailyView";

type Buyer = {
  username?: string;
  country?: string;
  [key: string]: any;
};

type OrderSummary = {
  id: number | string;
  code?: string;
  state?: string;
  orderAs?: string;
  buyer?: Buyer | null;
  size?: number;
  createdAt?: string | null;
  sellerTotalCents?: number | null;
  sellerTotalCurrency?: string | null;
  formattedTotal?: string | null;
  date?: string;
  allocated?: boolean;
};

type OrderItem = {
  id?: number | string;
  marketplaceOrderItemId?: string;
  cardTraderId?: number | null;
  manapoolInventoryId?: string | null;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  image_url?: string;
  imageUrl?: string;
  setCode?: string | null;
  set_name?: string;
  collectorNumber?: string | null;
  scryfallId?: string | null;
  tcgplayerSkuId?: string | null;
  manapoolCustomExternalId?: string | null;
  binLocations?: { bin: string; row: number; quantity: number }[];
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  source?: "manapool" | "cardtrader";
  isFoil?: boolean;
  condition?: string | null;
};

type OrderAllocation = {
  _id?: string;
  source?: "manapool" | "cardtrader";
  orderId?: string;
  orderItemId?: number;
  marketplaceOrderItemId?: string | null;
  cardTraderId?: number | null;
  manapoolInventoryId?: string | null;
  inventoryItem?: {
    _id?: string;
    name?: string | null;
    setCode?: string | null;
    cardTraderId?: number | null;
    blueprintId?: number | null;
    condition?: string | null;
    isFoil?: boolean;
    imageUrl?: string | null;
    identifiers?: {
      scryfallId?: string | null;
      mtgjsonUuid?: string | null;
      tcgplayerProductId?: string | null;
      tcgplayerSkuId?: string | null;
    };
    manapool?: {
      inventoryId?: string | null;
      productId?: string | null;
      productType?: string | null;
      tcgplayerSku?: string | null;
      scryfallId?: string | null;
      languageId?: string | null;
      conditionId?: string | null;
      finishId?: string | null;
      customExternalId?: string | null;
    };
  } | null;
  setCode?: string | null;
  scryfallId?: string | null;
  tcgplayerSkuId?: string | null;
  manapoolCustomExternalId?: string | null;
  requestedQuantity?: number;
  fulfilledQuantity?: number;
  unfilled?: number;
  name?: string;
  condition?: string | null;
  isFoil?: boolean;
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  status?: string;
  failureReason?: string | null;
  pickedLocations?: {
    bin?: any;
    row?: number;
    quantity?: number;
  }[];
};

const HIDDEN_REFUNDED_STORAGE_KEY = "manapool_hidden_refunded_order_ids_v1";

function getManaPoolLineRawId(it: any, index: number) {
  return (
    it?.id ??
    it?.order_item_id ??
    it?.order_line_id ??
    it?.line_id ??
    it?.uuid ??
    it?.seller_order_item_id ??
    `line-${index + 1}`
  );
}

function getManaPoolNumericOrderItemId(it: any, index: number) {
  const raw = getManaPoolLineRawId(it, index);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : index + 1;
}

function getManaPoolMarketplaceOrderItemId(it: any, index: number) {
  return String(getManaPoolLineRawId(it, index));
}

function getManaPoolInventoryId(it: any) {
  const raw =
    it?.inventory_id ??
    it?.seller_inventory_id ??
    it?.inventory?.id ??
    it?.seller_inventory?.id ??
    it?.inventory_item?.id ??
    it?.inventory?.inventory_id ??
    null;

  return raw == null ? null : String(raw);
}

function normalizeStatus(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isShippedManaPoolStatus(value?: string | null) {
  const status = normalizeStatus(value);
  return ["shipped", "sent", "fulfilled", "delivered"].includes(status);
}

function isRefundedManaPoolStatus(value?: string | null) {
  const status = normalizeStatus(value);
  return status.includes("refund");
}

function getStatusColor(value?: string | null) {
  const status = normalizeStatus(value);

  if (status === "hub_pending") return "yellow";
  if (
    status === "sent" ||
    status === "shipped" ||
    status === "fulfilled" ||
    status === "delivered"
  ) {
    return "green";
  }
  if (status.includes("refund")) return "red";
  if (status === "cancelled" || status === "canceled") return "red";

  return "gray";
}

function loadHiddenRefundedOrderIds() {
  if (typeof window === "undefined") return new Set<string>();

  try {
    const raw = window.localStorage.getItem(HIDDEN_REFUNDED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (err) {
    console.error("Failed to load hidden refunded ManaPool order ids", err);
    return new Set<string>();
  }
}

function persistHiddenRefundedOrderIds(next: Set<string>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      HIDDEN_REFUNDED_STORAGE_KEY,
      JSON.stringify([...next])
    );
  } catch (err) {
    console.error("Failed to save hidden refunded ManaPool order ids", err);
  }
}

function allocationToBinLocations(allocation?: OrderAllocation | null) {
  if (
    !allocation ||
    !Array.isArray(allocation.pickedLocations) ||
    allocation.pickedLocations.length === 0
  ) {
    return [];
  }

  return allocation.pickedLocations.map((pl) => {
    const binValue =
      pl.bin && typeof pl.bin === "object"
        ? pl.bin.label || pl.bin.name || pl.bin._id || "?"
        : pl.bin || "?";

    return {
      bin: String(binValue),
      row: Number(pl.row),
      quantity: Number(pl.quantity || 0),
    };
  });
}

export function OrdersView() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<string | number | null>(null);
  const [itemsByOrder, setItemsByOrder] = useState<
    Record<string | number, OrderItem[]>
  >({});

  const [viewMode, setViewMode] = useState<"orders" | "daily">("orders");

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);

  const [pickedMap, setPickedMap] = useState<
    Record<string | number, Record<string | number, boolean>>
  >({});

  const [hiddenRefundedOrderIds, setHiddenRefundedOrderIds] = useState<Set<string>>(
    () => loadHiddenRefundedOrderIds()
  );

  const visibleOrders = useMemo(
    () => orders.filter((o) => !hiddenRefundedOrderIds.has(String(o.id))),
    [orders, hiddenRefundedOrderIds]
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
        .map((o: any) => {
          const items = Array.isArray(o.items)
            ? o.items
            : Array.isArray(o.line_items)
            ? o.line_items
            : Array.isArray(o.order_items)
            ? o.order_items
            : Array.isArray(o.lines)
            ? o.lines
            : [];

          const buyerName =
            o.buyer?.username ||
            o.buyer?.name ||
            o.customer?.name ||
            o.customer_name ||
            o.shipping_address?.name ||
            o.shippingAddress?.name ||
            "Unknown";

          const buyerCountry =
            o.buyer?.country ||
            o.customer?.country ||
            o.shipping_address?.country ||
            o.shippingAddress?.country ||
            "";

          const status =
            o.latest_fulfillment_status ||
            o.fulfillment_status ||
            o.status ||
            o.state ||
            (Array.isArray(o.fulfillments) && o.fulfillments.length > 0
              ? "fulfilled"
              : "unfulfilled");

          return {
            id: o.id,
            code: o.label || o.number || o.code || String(o.id),
            state: status,
            orderAs: "Mana Pool",
            buyer: {
              username: buyerName,
              country: buyerCountry,
            },
            size:
              o.items_count ||
              o.line_items_count ||
              o.quantity ||
              items.reduce(
                (sum: number, item: any) =>
                  sum + Number(item.quantity || item.qty || 1),
                0
              ),
            createdAt: o.created_at || o.createdAt || o.inserted_at || null,
            sellerTotalCents:
              o.seller_total_cents ||
              o.payment?.total_cents ||
              o.total_cents ||
              o.subtotal_cents ||
              null,
            sellerTotalCurrency: o.seller_total_currency || o.currency || "USD",
            formattedTotal: o.formatted_total || o.total_formatted || null,
            allocated: false,
          };
        })
        .filter((o: OrderSummary) => !isShippedManaPoolStatus(o.state));

      setOrders(normalizedOrders);
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

  const loadItems = async (orderId: string | number) => {
    if (itemsByOrder[orderId]) return;

    try {
      const [orderRes, allocationRes] = await Promise.all([
        fetch(`/api/manapool/orders/${encodeURIComponent(String(orderId))}`),
        fetch(
          `/api/order-allocations/by-order/${encodeURIComponent(
            String(orderId)
          )}?source=manapool`
        ),
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

      const detailedBuyerName =
        order?.buyer?.username ||
        order?.buyer?.name ||
        order?.customer?.name ||
        order?.customer_name ||
        order?.shipping_address?.name ||
        order?.shippingAddress?.name ||
        "Unknown";

      const detailedBuyerCountry =
        order?.buyer?.country ||
        order?.customer?.country ||
        order?.shipping_address?.country ||
        order?.shippingAddress?.country ||
        "";

      const detailedItemCount = rawItemsArray.reduce(
        (sum: number, item: any) => sum + Number(item.quantity || item.qty || 1),
        0
      );

      setOrders((prev) =>
        prev.map((existingOrder) =>
          String(existingOrder.id) === String(orderId)
            ? {
                ...existingOrder,
                buyer: {
                  username: detailedBuyerName,
                  country: detailedBuyerCountry,
                },
                size: detailedItemCount,
                sellerTotalCents:
                  order?.payment?.total_cents ||
                  order?.total_cents ||
                  existingOrder.sellerTotalCents ||
                  null,
                sellerTotalCurrency:
                  order?.seller_total_currency ||
                  order?.currency ||
                  existingOrder.sellerTotalCurrency ||
                  "USD",
              }
            : existingOrder
        )
      );

      const allocations: OrderAllocation[] = allocationRes.ok
        ? await allocationRes.json()
        : [];

      const allocationByOrderItemId = new Map<number, OrderAllocation>();
      const allocationByMarketplaceId = new Map<string, OrderAllocation>();
      const allocationByManaPoolInventoryId = new Map<string, OrderAllocation>();

      for (const allocation of allocations || []) {
        if (typeof allocation.orderItemId === "number") {
          allocationByOrderItemId.set(allocation.orderItemId, allocation);
        }

        if (allocation.marketplaceOrderItemId) {
          allocationByMarketplaceId.set(
            String(allocation.marketplaceOrderItemId),
            allocation
          );
        }

        if (allocation.manapoolInventoryId) {
          allocationByManaPoolInventoryId.set(
            String(allocation.manapoolInventoryId),
            allocation
          );
        }
      }

      const normalizedItems: OrderItem[] = rawItemsArray.map((it: any, index: number) => {
        const numericOrderItemId = getManaPoolNumericOrderItemId(it, index);
        const marketplaceOrderItemId = getManaPoolMarketplaceOrderItemId(it, index);
        const manapoolInventoryId = getManaPoolInventoryId(it);

        const allocation =
          allocationByOrderItemId.get(numericOrderItemId) ||
          allocationByMarketplaceId.get(marketplaceOrderItemId) ||
          (manapoolInventoryId
            ? allocationByManaPoolInventoryId.get(manapoolInventoryId)
            : null) ||
          null;

        const manaPoolSingle = it?.product?.single || {};

        const setCodeRaw =
          allocation?.setCode ||
          allocation?.inventoryItem?.setCode ||
          manaPoolSingle?.set ||
          it.setCode ||
          it.set_code ||
          it.expansion_code ||
          null;

        const setCode =
          typeof setCodeRaw === "string" && setCodeRaw.trim()
            ? setCodeRaw.trim().toUpperCase()
            : null;

        const collectorNumber =
          manaPoolSingle?.number || it.collector_number || it.number || null;

        const setDisplay = setCode
          ? collectorNumber
            ? `${setCode} #${collectorNumber}`
            : setCode
          : it.set_name ||
            it.setName ||
            it.expansion_name ||
            it.product?.set_name ||
            it.product?.expansion_name ||
            null;

        return {
          id: numericOrderItemId,
          marketplaceOrderItemId,
          source: "manapool",
          cardTraderId: allocation?.cardTraderId ?? null,
          manapoolInventoryId,
          name:
            allocation?.name ||
            it.name ||
            it.product_name ||
            it.card_name ||
            it.title ||
            it.product?.name ||
            "No name",
          quantity:
            it.quantity || it.qty || it.count || allocation?.requestedQuantity || 1,
          imageUrl:
            it.image_url ||
            it.imageUrl ||
            it.product?.image_url ||
            it.product?.imageUrl ||
            null,
          setCode,
          set_name: setDisplay || "Unknown set",
          collectorNumber,
          scryfallId:
            allocation?.scryfallId ||
            allocation?.inventoryItem?.manapool?.scryfallId ||
            allocation?.inventoryItem?.identifiers?.scryfallId ||
            manaPoolSingle?.scryfall_id ||
            null,
          tcgplayerSkuId:
            allocation?.tcgplayerSkuId ||
            allocation?.inventoryItem?.identifiers?.tcgplayerSkuId ||
            allocation?.inventoryItem?.manapool?.tcgplayerSku ||
            String(it.tcgsku || it.product?.tcgplayer_sku || "") ||
            null,
          manapoolCustomExternalId:
            allocation?.manapoolCustomExternalId ||
            allocation?.inventoryItem?.manapool?.customExternalId ||
            it.custom_external_id ||
            null,
          condition:
            allocation?.condition ??
            it.condition ??
            it.condition_name ??
            it.product?.condition ??
            null,
          isFoil:
            allocation?.isFoil ??
            Boolean(
              it.is_foil ||
                it.isFoil ||
                it.foil ||
                it.finish === "foil" ||
                it.product?.is_foil ||
                it.product?.foil
            ),
          picked: !!allocation?.picked,
          pickedAt: allocation?.pickedAt || null,
          pickedBy: allocation?.pickedBy || null,
          binLocations: allocationToBinLocations(allocation),
        };
      });

      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: normalizedItems,
      }));
    } catch (err) {
      console.error("Failed loading Mana Pool order items", err);
      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: [],
      }));
    }
  };

  const getCardImageSrc = (it: OrderItem) => {
    const dbImage = it.imageUrl || it.image_url;

    if (dbImage && typeof dbImage === "string" && dbImage.startsWith("http")) {
      return dbImage;
    }

    return "/card-placeholder.png";
  };

  const toggle = (id: string | number) => {
    const willExpand = expanded !== id;
    setExpanded(willExpand ? id : null);
    if (willExpand) loadItems(id);
  };

  const getBuyerDisplay = (buyer?: Buyer | null) => {
    if (!buyer) return "Unknown";
    if (buyer.username && buyer.country) return `${buyer.username} (${buyer.country})`;
    return buyer.username || buyer.country || "Unknown";
  };

  const formatLocalDate = (iso?: string | null) => {
    if (!iso) return "-";
    return new Date(iso).toLocaleString("en-CA", {
      timeZone: "America/Toronto",
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const formatTotal = (o: OrderSummary) => {
    if (o.formattedTotal) return o.formattedTotal;
    if (o.sellerTotalCents && o.sellerTotalCurrency) {
      return `${(o.sellerTotalCents / 100).toFixed(2)} ${o.sellerTotalCurrency}`;
    }
    return "-";
  };

  const sortOrderItems = (items: OrderItem[]): OrderItem[] => {
    return [...items].sort((a, b) => {
      const aHasBin = !!(a.binLocations && a.binLocations.length > 0);
      const bHasBin = !!(b.binLocations && b.binLocations.length > 0);

      if (aHasBin && !bHasBin) return -1;
      if (!aHasBin && bHasBin) return 1;

      if (aHasBin && bHasBin) {
        const aLoc = a.binLocations![0];
        const bLoc = b.binLocations![0];
        const aBin = (aLoc.bin || "").toString();
        const bBin = (bLoc.bin || "").toString();

        if (aBin !== bBin) {
          return aBin.localeCompare(bBin, undefined, { numeric: true });
        }

        const aRow = aLoc.row ?? Number.MAX_SAFE_INTEGER;
        const bRow = bLoc.row ?? Number.MAX_SAFE_INTEGER;
        return aRow - bRow;
      }

      const aSet = (a.set_name || "").toString();
      const bSet = (b.set_name || "").toString();
      if (aSet !== bSet) return aSet.localeCompare(bSet, undefined, { numeric: true });

      const aName = (a.name || "").toString();
      const bName = (b.name || "").toString();
      return aName.localeCompare(bName, undefined, { numeric: true });
    });
  };

  const handleHideRefundedOrder = (orderId: string | number) => {
    const next = new Set(hiddenRefundedOrderIds);
    next.add(String(orderId));
    setHiddenRefundedOrderIds(next);
    persistHiddenRefundedOrderIds(next);

    if (expanded === orderId) {
      setExpanded(null);
    }
  };

  const handleClearHiddenRefundedOrders = () => {
    const next = new Set<string>();
    setHiddenRefundedOrderIds(next);
    persistHiddenRefundedOrderIds(next);
  };

  const handleSyncOrders = async () => {
    try {
      setSyncing(true);
      setConfirmSync(false);
      setSyncMessage(null);
      setSyncError(null);

      const res = await fetch("/api/orders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initiatedBy: window.localStorage.getItem("ctfinal_staff_name") || "local",
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to sync orders");
      }

      setSyncMessage(
        `Safe sync complete. Eligible: ${data.eligibleOrders ?? 0}, reconciled: ${
          data.reconciled ?? 0
        }, failed: ${data.failed ?? 0}. Cutoff: ${data.cutoff ?? "none"}`
      );

      fetchOrders();
    } catch (err: any) {
      console.error("Sync failed:", err);
      setSyncError(err.message || "Failed to sync orders");
    } finally {
      setSyncing(false);
    }
  };

  const handleTogglePicked = async (orderId: string | number, item: OrderItem) => {
    const ctId = item.cardTraderId;
    if (typeof ctId === "undefined" || ctId === null) {
      console.warn("No cardTraderId on item, cannot toggle picked");
      return;
    }

    const pickedKey = typeof item.id === "number" ? item.id : ctId;
    const currentForOrder = pickedMap[orderId] || {};
    const currentlyPicked = !!currentForOrder[pickedKey];
    const nextPicked = !currentlyPicked;

    try {
      const endpoint = nextPicked ? "pick" : "unpick";

      const res = await fetch(`/api/order-allocations/${endpoint}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          orderItemId: item.id,
          cardTraderId: ctId,
          pickedBy: window.localStorage.getItem("ctfinal_staff_name") || "manual",
          source: "manapool",
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to ${endpoint} allocation`,
          res.status,
          txt.slice(0, 300)
        );
        return;
      }

      setPickedMap((prev) => {
        const existing = prev[orderId] || {};
        return {
          ...prev,
          [orderId]: {
            ...existing,
            [pickedKey]: nextPicked,
          },
        };
      });
    } catch (err) {
      console.error("Error toggling picked state", err);
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={2}>Orders</Title>
          <Text c="dimmed" size="sm">
            Mana Pool seller orders. Shipped and delivered orders are removed automatically. Refunded orders stay visible until you hide them from this view.
          </Text>
        </div>

        <Group gap="xs">
          <SegmentedControl
            size="sm"
            value={viewMode}
            onChange={(val) => setViewMode(val as "orders" | "daily")}
            data={[
              { label: "Orders", value: "orders" },
              { label: "Daily sales", value: "daily" },
            ]}
          />

          <Button onClick={fetchOrders} loading={loading} variant="light">
            Refresh
          </Button>

          {hiddenRefundedOrderIds.size > 0 && (
            <Button size="sm" variant="subtle" onClick={handleClearHiddenRefundedOrders}>
              Show hidden refunds ({hiddenRefundedOrderIds.size})
            </Button>
          )}

          <Button
            leftSection={<IconArrowsDownUp size={16} />}
            onClick={() => setConfirmSync(true)}
            loading={syncing}
            variant="filled"
            color="red"
          >
            Run Safe Sync
          </Button>
        </Group>
      </Group>

      {error && (
        <Paper p="sm" withBorder>
          <Text c="red">{error}</Text>
        </Paper>
      )}

      {syncMessage && (
        <Paper p="sm" withBorder>
          <Text c="teal">{syncMessage}</Text>
        </Paper>
      )}

      {syncError && (
        <Paper p="sm" withBorder>
          <Text c="red">{syncError}</Text>
        </Paper>
      )}

      {viewMode === "orders" && (
        <Paper withBorder radius="md" p={0}>
          <ScrollArea h={500}>
            <Table withColumnBorders highlightOnHover striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Buyer</Table.Th>
                  <Table.Th>Items</Table.Th>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Total</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>

              <Table.Tbody>
                {!loading && visibleOrders.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7} ta="center">
                      <Text c="dimmed">No Mana Pool orders found.</Text>
                    </Table.Td>
                  </Table.Tr>
                )}

                {visibleOrders.map((o) => {
                  const refunded = isRefundedManaPoolStatus(o.state);

                  return (
                    <React.Fragment key={o.id}>
                      <Table.Tr
                        onClick={() => toggle(o.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <Table.Td>
                          <Group gap={6}>
                            <Text fw={500}>{o.code}</Text>
                            {o.allocated && (
                              <Badge size="xs" color="yellow" variant="filled">
                                Allocated
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            as {o.orderAs}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Badge color={getStatusColor(o.state)}>{o.state}</Badge>
                        </Table.Td>

                        <Table.Td>{getBuyerDisplay(o.buyer)}</Table.Td>
                        <Table.Td>{o.size ?? "-"}</Table.Td>
                        <Table.Td>{formatLocalDate(o.createdAt)}</Table.Td>
                        <Table.Td>{formatTotal(o)}</Table.Td>

                        <Table.Td>
                          <Group gap={6} justify="flex-end" wrap="nowrap">
                            {refunded && (
                              <Button
                                size="xs"
                                variant="light"
                                color="red"
                                leftSection={<IconTrash size={14} />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleHideRefundedOrder(o.id);
                                }}
                              >
                                Hide refund
                              </Button>
                            )}

                            <Button
                              size="xs"
                              variant="light"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(o.id);
                              }}
                            >
                              View
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>

                      {expanded === o.id && (
                        <Table.Tr>
                          <Table.Td colSpan={7} style={{ background: "#111", padding: 0 }}>
                            <Box p="md">
                              {!itemsByOrder[o.id] && (
                                <Group justify="center" p="lg">
                                  <Loader size="sm" color="yellow" />
                                </Group>
                              )}

                              {itemsByOrder[o.id]?.length === 0 && (
                                <Text c="dimmed" ta="center">
                                  No line items found.
                                </Text>
                              )}

                              {!!itemsByOrder[o.id]?.length && (
                                <Stack gap="md">
                                  {sortOrderItems(itemsByOrder[o.id]).map((it, idx) => {
                                    const ctId =
                                      typeof it.cardTraderId === "number"
                                        ? it.cardTraderId
                                        : undefined;

                                    const pickedKey =
                                      typeof it.id === "number" ? it.id : ctId;

                                    const isPicked =
                                      pickedKey !== undefined &&
                                      !!pickedMap[o.id]?.[pickedKey];

                                    return (
                                      <Group key={idx} align="flex-start" wrap="nowrap">
                                        <img
                                          src={getCardImageSrc(it)}
                                          width={50}
                                          height={70}
                                          style={{ objectFit: "cover", borderRadius: 4 }}
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).src =
                                              "/card-placeholder.png";
                                          }}
                                        />

                                        <Box style={{ flex: 1 }}>
                                          <Text fw={500}>{it.name || "No name"}</Text>
                                          <Text size="xs" c="dimmed">
                                            {it.set_name || it.setCode || "Unknown set"}
                                          </Text>

                                          <Group gap={6} mt={6}>
                                            <Badge
                                              size="sm"
                                              color={it.isFoil ? "yellow" : "gray"}
                                              variant={it.isFoil ? "filled" : "light"}
                                            >
                                              {it.isFoil ? "Foil" : "Non-Foil"}
                                            </Badge>

                                            {it.condition && (
                                              <Badge size="sm" variant="light" color="blue">
                                                {it.condition}
                                              </Badge>
                                            )}
                                          </Group>

                                          <Text size="sm" mt={4}>
                                            Qty: {it.quantity ?? "?"}
                                          </Text>

                                          <Group gap={6} mt={6}>
                                            {it.binLocations?.length ? (
                                              it.binLocations.map((b, i) => (
                                                <Badge key={i} color="yellow">
                                                  {b.bin ?? "?"} / Row {b.row ?? "?"} (x
                                                  {b.quantity ?? "?"})
                                                </Badge>
                                              ))
                                            ) : (
                                              <Badge color="red" variant="light">
                                                Unassigned
                                              </Badge>
                                            )}
                                          </Group>
                                        </Box>

                                        <Button
                                          size="xs"
                                          variant={isPicked ? "filled" : "outline"}
                                          color={isPicked ? "green" : "gray"}
                                          onClick={() => handleTogglePicked(o.id, it)}
                                        >
                                          {isPicked ? "Picked" : "Mark picked"}
                                        </Button>
                                      </Group>
                                    );
                                  })}
                                </Stack>
                              )}
                            </Box>
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      {viewMode === "daily" && <OrdersDailyView />}
      <Modal opened={confirmSync} onClose={() => setConfirmSync(false)} title="Run CardTrader order sync" centered radius="lg">
        <Stack>
          <Alert color="yellow" title="Inventory-affecting operation">
            CTFinal will fetch eligible CardTrader orders and deduct inventory only for new exact listing matches. Existing allocation records prevent duplicate deductions.
          </Alert>
          <Text size="sm" c="dimmed">The configured order cutoff remains active. A durable result, including any failures, will be written to Operation History.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmSync(false)}>Cancel</Button>
            <Button color="red" leftSection={<IconArrowsDownUp size={16} />} onClick={handleSyncOrders}>Run sync now</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
