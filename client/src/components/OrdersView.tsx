import React, { useEffect, useState } from "react";import {
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  SegmentedControl,
} from "@mantine/core";
import { IconArrowsDownUp } from "@tabler/icons-react";

// 👇 adjust the path if your file is in a different folder
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

  date?: string; // extracted YYYY-MM-DD

  allocated?: boolean;
};

type OrderItem = {
  id?: number;
  cardTraderId?: number;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  image_url?: string;
  imageUrl?: string;
  set_name?: string;
  binLocations?: { bin: string; row: number; quantity: number }[];

  // 👇 ADD THIS
  isFoil?: boolean;
  condition?: string | null;
};
type AllocationPickState = {
  orderId: string;
  orderItemId?: number;
  cardTraderId: number;
  picked: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
};

export function OrdersView() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<string | number | null>(null);
  const [itemsByOrder, setItemsByOrder] = useState<
    Record<string | number, OrderItem[]>
  >({});

  // 👇 toggle between raw Orders list and Daily sales
  const [viewMode, setViewMode] = useState<"orders" | "daily">("orders");

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // ✅ NEW: map of orderId -> { cardTraderId -> picked }
  const [pickedMap, setPickedMap] = useState<
    Record<string | number, Record<number, boolean>>
  >({});

 const fetchOrders = async () => {
  try {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/manapool/orders?limit=50");
    if (!res.ok) throw new Error("Failed to load Mana Pool orders");

    const payload = await res.json();

    const manaPoolOrders = payload?.data?.orders || [];

    const normalizedOrders: OrderSummary[] = manaPoolOrders.map((o: any) => ({
      id: o.id,
      code: o.number || o.code || String(o.id),
      state: o.status || o.state || "unknown",
      orderAs: "Mana Pool",
      buyer: {
        username:
          o.buyer?.username ||
          o.buyer?.name ||
          o.customer?.name ||
          o.customer_name ||
          "Unknown",
        country:
          o.buyer?.country ||
          o.customer?.country ||
          o.shipping_address?.country ||
          "",
      },
      size:
        o.items_count ||
        o.line_items_count ||
        o.quantity ||
        o.items?.length ||
        o.line_items?.length ||
        0,
      createdAt: o.created_at || o.createdAt || o.inserted_at || null,
      sellerTotalCents:
        o.seller_total_cents ||
        o.total_cents ||
        o.subtotal_cents ||
        null,
      sellerTotalCurrency:
        o.seller_total_currency ||
        o.currency ||
        "USD",
      formattedTotal:
        o.formatted_total ||
        o.total_formatted ||
        null,
      allocated: false,
    }));

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

  const loadPickStateForOrder = async (orderId: string | number) => {
    try {
      const res = await fetch(
        `/api/order-allocations/by-order/${encodeURIComponent(
          String(orderId)
        )}`
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to load pick state for order ${orderId}: ${res.status}`,
          txt.slice(0, 300)
        );
        return;
      }

      const data: AllocationPickState[] = await res.json();

      const perLine: Record<number, boolean> = {};
for (const alloc of data) {
  const key =
    typeof alloc.orderItemId === "number"
      ? alloc.orderItemId
      : alloc.cardTraderId;

  if (typeof key === "number") {
    perLine[key] = !!alloc.picked;
  }
}

      setPickedMap((prev) => ({
        ...prev,
        [orderId]: perLine,
      }));
    } catch (err) {
      console.error("Error loading pick state for order", orderId, err);
    }
  };

  const loadItems = async (orderId: string | number) => {
  if (itemsByOrder[orderId]) {
    return;
  }

  try {
    const res = await fetch(
      `/api/manapool/orders/${encodeURIComponent(String(orderId))}`
    );

    if (!res.ok) {
      throw new Error(`Failed to load Mana Pool order items: ${res.status}`);
    }

    const payload = await res.json();

    const order = payload?.data || payload;

    const rawItems =
      order?.items ||
      order?.line_items ||
      order?.order_items ||
      order?.articles ||
      [];

    const normalizedItems: OrderItem[] = rawItems.map((it: any) => ({
      id: it.id || it.order_item_id || it.line_item_id,

      // Mana Pool fields / generic fields
      name:
        it.name ||
        it.product_name ||
        it.card_name ||
        it.title ||
        it.product?.name ||
        "No name",

      quantity:
        it.quantity ||
        it.qty ||
        it.count ||
        1,

      imageUrl:
        it.image_url ||
        it.imageUrl ||
        it.product?.image_url ||
        it.product?.imageUrl ||
        null,

      set_name:
        it.set_name ||
        it.setName ||
        it.expansion_name ||
        it.product?.set_name ||
        it.product?.expansion_name ||
        "Unknown set",

      condition:
        it.condition ||
        it.condition_name ||
        it.product?.condition ||
        null,

      isFoil:
        Boolean(
          it.is_foil ||
            it.isFoil ||
            it.foil ||
            it.finish === "foil" ||
            it.product?.is_foil ||
            it.product?.foil
        ),

      // No bin logic yet. That comes after we connect Mana Pool SKUs to inventoryItems.
      binLocations: [],
    }));

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

  // ⭐ FIXED IMAGE SELECTOR – supports BOTH imageUrl + image_url ⭐
  const getCardImageSrc = (it: OrderItem) => {
    // 1) Prefer camelCase (future /api/orders items) then snake_case (/api/order-articles)
    const dbImage = it.imageUrl || it.image_url;

    if (dbImage && typeof dbImage === "string" && dbImage.startsWith("http")) {
      return dbImage;
    }

    // Final fallback → local placeholder
return "/card-placeholder.png";

  const toggle = (id: string | number) => {
    const willExpand = expanded !== id;
    setExpanded(willExpand ? id : null);
    if (willExpand) loadItems(id);
  };

  const getBuyerDisplay = (buyer?: Buyer | null) => {
    if (!buyer) return "Unknown";
    if (buyer.username && buyer.country)
      return `${buyer.username} (${buyer.country})`;
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
    if (o.sellerTotalCents && o.sellerTotalCurrency)
      return `${(o.sellerTotalCents / 100).toFixed(2)} ${
        o.sellerTotalCurrency
      }`;
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

        if (aBin !== bBin)
          return aBin.localeCompare(bBin, undefined, { numeric: true });

        const aRow = aLoc.row ?? Number.MAX_SAFE_INTEGER;
        const bRow = bLoc.row ?? Number.MAX_SAFE_INTEGER;
        return aRow - bRow;
      }

      const aSet = (a.set_name || "").toString();
      const bSet = (b.set_name || "").toString();
      if (aSet !== bSet)
        return aSet.localeCompare(bSet, undefined, { numeric: true });

      const aName = (a.name || "").toString();
      const bName = (b.name || "").toString();
      return aName.localeCompare(bName, undefined, { numeric: true });
    });
  };

  const handleSyncOrders = async () => {
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

  // ✅ Toggle picked state for ONE card line
  const handleTogglePicked = async (
    orderId: string | number,
    item: OrderItem
  ) => {
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
  pickedBy: "manual", // you can wire your username later
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

      // If backend succeeded, update local map
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
  Mana Pool seller orders. Expand an order to view line items, or switch to Daily Sales.
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

          <Button
            leftSection={<IconArrowsDownUp size={16} />}
            onClick={handleSyncOrders}
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
                {!loading && orders.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7} ta="center">
                      <Text c="dimmed">No Mana Pool orders found.</Text>
                    </Table.Td>
                  </Table.Tr>
                )}

                {orders.map((o) => (
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
                        <Badge
                          color={
                            o.state?.toUpperCase() === "HUB_PENDING"
                              ? "yellow"
                              : o.state === "sent"
                              ? "green"
                              : "gray"
                          }
                        >
                          {o.state}
                        </Badge>
                      </Table.Td>

                      <Table.Td>{getBuyerDisplay(o.buyer)}</Table.Td>
                      <Table.Td>{o.size ?? "-"}</Table.Td>
                      <Table.Td>{formatLocalDate(o.createdAt)}</Table.Td>
                      <Table.Td>{formatTotal(o)}</Table.Td>

                      <Table.Td>
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
                                          {it.set_name || "Unknown set"}
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
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      {viewMode === "daily" && <OrdersDailyView />}
    </Stack>
  );
}