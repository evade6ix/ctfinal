import { useEffect, useState } from "react";
import {
  Box,
  Title,
  Text,
  Table,
  Loader,
  Center,
  ScrollArea,
  Group,
  Badge,
  Card,
  Alert,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

type OrderLine = {
  cardTraderId?: number;
  name?: string;
  setCode?: string;
  quantity: number;
  price?: number;
};

type Order = {
  _id: string;
  cardTraderOrderId?: number;
  status?: string;
  buyerName?: string;
  buyerCountry?: string;
  totalAmount?: number;
  currency?: string;
  placedAt?: string;
  lines?: OrderLine[];
};

const API_BASE = "/api";

export function OrdersDbView() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const fetchOrders = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`${API_BASE}/orders/db`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch DB orders (${res.status})`);
        }

        const data = await res.json();
        const list: Order[] = Array.isArray(data.orders) ? data.orders : [];
        setOrders(list);
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.error("Error fetching DB orders:", err);
        setError(err.message || "Failed to fetch DB orders");
      } finally {
        setLoading(false);
      }
    };

    fetchOrders();

    return () => controller.abort();
  }, []);

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Title order={2}>Orders (local DB)</Title>
          <Text c="dimmed" size="sm">
            These are orders stored in MongoDB. Later we&apos;ll attach bin
            allocations and picklists to them.
          </Text>
        </div>
        <Group gap="xs">
          <Badge variant="light">Total DB orders: {orders.length}</Badge>
        </Group>
      </Group>

      {loading && (
        <Center mih={200}>
          <Loader />
        </Center>
      )}

      {!loading && error && (
        <Alert
          color="red"
          icon={<IconAlertTriangle size={18} />}
          mb="md"
        >
          {error}
        </Alert>
      )}

      {!loading && !error && orders.length === 0 && (
        <Text c="dimmed">No orders in the local DB yet.</Text>
      )}

      {!loading && !error && orders.length > 0 && (
        <Card withBorder radius="lg">
          <ScrollArea.Autosize mah="calc(100vh - 180px)">
            <Table
              highlightOnHover
              verticalSpacing="xs"
              striped
              withTableBorder
              withColumnBorders
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>CT Order ID</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Buyer</Table.Th>
                  <Table.Th>Country</Table.Th>
                  <Table.Th>Lines</Table.Th>
                  <Table.Th ta="right">Total</Table.Th>
                  <Table.Th>Placed</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {orders.map((o) => {
                  const lineCount = (o.lines || []).length;
                  const totalQty = (o.lines || []).reduce(
                    (sum, l) => sum + (l.quantity || 0),
                    0
                  );

                  const placed =
                    o.placedAt || (o as any).createdAt || null;

                  return (
                    <Table.Tr key={o._id}>
                      <Table.Td>
                        <Text fw={500}>
                          {o.cardTraderOrderId ?? "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {o.status ? (
                          <Badge size="sm" variant="light">
                            {o.status}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {o.buyerName || "Unknown"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {o.buyerCountry || "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {lineCount} lines / {totalQty} cards
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        {typeof o.totalAmount === "number" ? (
                          <Text size="sm" fw={600}>
                            {o.totalAmount.toFixed(2)}{" "}
                            {o.currency || ""}
                          </Text>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {placed
                            ? new Date(placed).toLocaleString()
                            : "—"}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Card>
      )}
    </Box>
  );
}
