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
};

type OrderItem = {
  id?: number;
  cardTraderId?: number;
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

  // 🔥 FIXED: use /api/order-articles/:id and always set itemsByOrder
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

  const formatDate = (d?: string | null) => d || "-";

  const formatTotal = (o: OrderSummary) => {
    if (o.formattedTotal) return o.formattedTotal;
    if (o.sellerTotalCents && o.sellerTotalCurrency)
      return `${(o.sellerTotalCents / 100).toFixed(2)} ${
        o.sellerTotalCurrency
      }`;
    return "-";
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

        <Button onClick={fetchOrders} loading={loading} variant="light">
          Refresh
        </Button>
      </Group>

      {error && (
        <Paper p="sm" withBorder>
          <Text c="red">{error}</Text>
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
                      <Text fw={500}>{o.code}</Text>
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
                    <Table.Td>{formatDate(o.date)}</Table.Td>
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
                                {itemsByOrder[o.id].map((it, idx) => (
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
                                      src={
                                        it.image_url ||
                                        "https://cards.scryfall.io/large/front/0/1/placeholder.jpg"
                                      }
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
                                        {(it.binLocations || []).map((b, i) => (
                                          <Badge key={i} color="yellow">
                                            {b.bin ?? "?"} / Row{" "}
                                            {b.row ?? "?"} (x
                                            {b.quantity ?? "?"})
                                          </Badge>
                                        ))}
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
                                ))}
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
