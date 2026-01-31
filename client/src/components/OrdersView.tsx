import { useEffect, useState } from "react";
import {
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
  image_url?: string; // from /api/order-articles
  imageUrl?: string; // future /api/orders usage if we wire it
  set_name?: string;
  binLocations?: { bin: string; row: number; quantity: number }[];
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

  const fetchOrders = async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/orders");
      if (!res.ok) throw new Error("Failed to load orders");

      const data: OrderSummary[] = await res.json();

      // ✅ Only keep HUB_PENDING (Zero) orders in this view
      const zeroOrders = (data || []).filter(
        (o) => o.state && o.state.toUpperCase() === "HUB_PENDING"
      );

      setOrders(zeroOrders);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to load orders");
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
      const res = await fetch(`/api/order-articles/${orderId}`);

      if (!res.ok) {
        throw new Error(`Failed to load order items: ${res.status}`);
      }

      const data: OrderItem[] = await res.json();

      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: data,
      }));
    } catch (err) {
      console.error("Failed loading order items", err);
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

    // 2) Fallback → CardTrader Blueprint CDN
    const blueprintId = it.blueprintId ?? it.cardTraderId;
    if (blueprintId) {
      return `https://img.cardtrader.com/blueprints/${blueprintId}/front.jpg`;
    }

    // 3) Final fallback → local placeholder
    return "/card-placeholder.png";
  };

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
    try {
      setSyncing(true);
      setSyncMessage(null);
      setSyncError(null);

      const res = await fetch("/api/orders/sync", { method: "POST" });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to sync orders");
      }

      const data = await res.json();
      setSyncMessage(
        data.message ??
          `Sync complete. Updated ${data.updatedLines ?? 0} order lines.`
      );

      fetchOrders();
    } catch (err: any) {
      console.error("Sync failed:", err);
      setSyncError(err.message || "Failed to sync orders");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={2}>Orders</Title>
          <Text c="dimmed" size="sm">
            CardTrader{" "}
            <strong>HUB_PENDING (Zero)</strong> seller orders only. Expand an
            order to view line items, or switch to Daily Sales.
          </Text>
        </div>

        <Group gap="xs">
          {/* 👇 view mode toggle */}
          <SegmentedControl
            size="sm"
            value={viewMode}
            onChange={(val) => setViewMode(val as "orders" | "daily")}
            data={[
              { label: "Orders", value: "orders" },
              { label: "Daily sales", value: "daily" },
            ]}
          />

          {/* Keep your existing buttons */}
          <Button onClick={fetchOrders} loading={loading} variant="light">
            Refresh
          </Button>

          <Button
            leftSection={<IconArrowsDownUp size={16} />}
            onClick={handleSyncOrders}
            loading={syncing}
            variant="filled"
            color="yellow"
          >
            Sync allocated orders
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

      {/* 👇 Orders list mode */}
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
                      <Text c="dimmed">No HUB_PENDING orders found.</Text>
                    </Table.Td>
                  </Table.Tr>
                )}

                {orders.map((o) => (
                  <>
                    <Table.Tr
                      key={o.id}
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
                      <Table.Tr key={`${o.id}-expanded`}>
                        <Table.Td
                          colSpan={7}
                          style={{
                            background: "#111",
                            padding: 0,
                            borderTop: "2px solid #333",
                          }}
                        >
                          <Box p="md">
                            {!itemsByOrder[o.id] && (
                              <Group justify="center" p="lg">
                                <Loader size="sm" color="yellow" />
                              </Group>
                            )}

                            {itemsByOrder[o.id] &&
                              itemsByOrder[o.id].length === 0 && (
                                <Text c="dimmed" ta="center">
                                  No line items found.
                                </Text>
                              )}

                            {itemsByOrder[o.id] &&
                              itemsByOrder[o.id].length > 0 && (
                                <Stack gap="md">
                                  {sortOrderItems(itemsByOrder[o.id]).map(
                                    (it, idx) => (
                                      <Group
                                        key={idx}
                                        align="flex-start"
                                        wrap="nowrap"
                                        style={{
                                          padding: "8px 0",
                                          borderBottom: "1px solid #333",
                                        }}
                                      >
                                        <img
                                          src={getCardImageSrc(it)}
                                          width={50}
                                          height={70}
                                          style={{
                                            objectFit: "cover",
                                            borderRadius: 4,
                                          }}
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).src =
                                              "/card-placeholder.png";
                                          }}
                                        />

                                        <Box style={{ flex: 1 }}>
                                          <Text fw={500}>
                                            {it.name || "No name"}
                                          </Text>
                                          <Text size="xs" c="dimmed">
                                            {it.set_name || "Unknown set"}
                                          </Text>

                                          <Text size="sm" mt={4}>
                                            Qty: {it.quantity ?? "?"}
                                          </Text>

                                          <Group gap={6} mt={6}>
                                            {(it.binLocations || []).map(
                                              (b, i) => (
                                                <Badge key={i} color="yellow">
                                                  {b.bin ?? "?"} / Row{" "}
                                                  {b.row ?? "?"} (x
                                                  {b.quantity ?? "?"})
                                                </Badge>
                                              )
                                            )}
                                          </Group>
                                        </Box>

                                        <Button
                                          color="yellow"
                                          size="xs"
                                          variant="filled"
                                          disabled
                                        >
                                          Deduct
                                        </Button>
                                      </Group>
                                    )
                                  )}
                                </Stack>
                              )}
                          </Box>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      {/* 👇 Daily sales mode */}
      {viewMode === "daily" && <OrdersDailyView />}
    </Stack>
  );
}
