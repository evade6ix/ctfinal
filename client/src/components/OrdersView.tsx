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
} from "@mantine/core";
import { IconArrowsDownUp } from "@tabler/icons-react";

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

  allocated?: boolean; // 🔹 new flag from backend
};

type OrderItem = {
  id?: number;
  cardTraderId?: number;
  blueprintId?: number; // optional, if backend sends this later
  name?: string;
  quantity?: number;
  image_url?: string;
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

  // 🔹 new state for sync button
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
      setOrders(data);
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

  // 🔥 use /api/order-articles/:id and always set itemsByOrder
  const loadItems = async (orderId: string | number) => {
    if (itemsByOrder[orderId]) return; // cached

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

  const getCardImageSrc = (it: OrderItem) => {
  // 1) Prefer the Mongo / inventory image_url
  if (it.image_url && it.image_url.startsWith("http")) {
    return it.image_url;
  }

  // 2) Fall back to CardTrader blueprint/listing image if available
  const blueprintId = it.blueprintId ?? it.cardTraderId;
  if (blueprintId) {
    return `https://img.cardtrader.com/blueprints/${blueprintId}/front.jpg`;
  }

  // 3) Final fallback: generic placeholder
  return "https://cards.scryfall.io/large/front/0/1/placeholder.jpg";
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

  // 🔹 sort items: bins first (by bin → row), then no-bin by set_name → name
  const sortOrderItems = (items: OrderItem[]): OrderItem[] => {
    return [...items].sort((a, b) => {
      const aHasBin = !!(a.binLocations && a.binLocations.length > 0);
      const bHasBin = !!(b.binLocations && b.binLocations.length > 0);

      // 1) Items WITH bins first
      if (aHasBin && !bHasBin) return -1;
      if (!aHasBin && bHasBin) return 1;

      // 2) If both HAVE bins → sort by bin name then row
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

      // 3) Neither has bins → group/sort by set_name, then name
      const aSet = (a.set_name || "").toString();
      const bSet = (b.set_name || "").toString();

      if (aSet !== bSet) {
        return aSet.localeCompare(bSet, undefined, { numeric: true });
      }

      const aName = (a.name || "").toString();
      const bName = (b.name || "").toString();

      return aName.localeCompare(bName, undefined, { numeric: true });
    });
  };

  // 🔹 sync allocated orders -> hits POST /api/orders/sync
  const handleSyncOrders = async () => {
    try {
      setSyncing(true);
      setSyncMessage(null);
      setSyncError(null);

      const res = await fetch("/api/orders/sync", {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to sync orders");
      }

      const data = await res.json();
      setSyncMessage(
        data.message ??
          `Sync complete. Updated ${data.updatedLines ?? 0} order lines.`
      );

      // Optional: refetch orders so allocated flags / totals refresh
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
            CardTrader seller orders. Expand an order to view line items.
          </Text>
        </div>

        <Group gap="xs">
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
                    <Text c="dimmed">No orders found.</Text>
                  </Table.Td>
                </Table.Tr>
              )}

              {orders.map((o) => (
                <>
                  {/* MAIN ORDER ROW */}
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
                          o.state === "paid"
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

                  {/* EXPANDED VIEW */}
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
                          {/* LOADING */}
                          {!itemsByOrder[o.id] && (
                            <Group justify="center" p="lg">
                              <Loader size="sm" color="yellow" />
                            </Group>
                          )}

                          {/* NO ITEMS */}
                          {itemsByOrder[o.id] &&
                            itemsByOrder[o.id].length === 0 && (
                              <Text c="dimmed" ta="center">
                                No line items found.
                              </Text>
                            )}

                          {/* ITEMS */}
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
                                      {/* IMAGE */}
<img
  src={getCardImageSrc(it)}
  width={50}
  height={70}
  style={{
    objectFit: "cover",
    borderRadius: 4,
  }}
  onError={(e) =>
    ((e.target as HTMLImageElement).src =
      "https://cards.scryfall.io/large/front/0/1/placeholder.jpg")
  }
/>

                                      {/* DETAILS */}
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

                                        {/* BIN LOCATIONS */}
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
    </Stack>
  );
}
