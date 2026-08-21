import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

type ApiOrder = {
  id: number | string;
  code?: string;
  state?: string;
  createdAt?: string | null;
  size?: number | null;
  sellerTotalCents?: number | null;
  sellerTotalCurrency?: string | null;
  formattedTotal?: string | null;
  allocated?: boolean;
};

export function OrdersWeeklyView() {
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxWeeks, setMaxWeeks] = useState("8");

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        // ⬇️ Use the normalized orders endpoint
        const res = await fetch("/api/orders");
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(
            `Failed to load orders (${res.status}): ${txt || "Unknown error"}`
          );
        }

        const data = (await res.json()) as ApiOrder[];

        // ✅ Only keep orders with state === "paid"
        const paid = (Array.isArray(data) ? data : []).filter((o) =>
          String(o.state || "").toLowerCase() === "paid"
        );

        setOrders(paid);
      } catch (err: any) {
        console.error(err);
        setError(err.message || "Failed to load orders");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const max = parseInt(maxWeeks || "8", 10);

  // 🕒 Filter by "last N weeks" using createdAt
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - max * 7);

  const visibleOrders = orders
    .filter((o) => {
      if (!o.createdAt) return false;
      const d = new Date(o.createdAt);
      if (isNaN(d.getTime())) return false;
      return d >= cutoff;
    })
    .sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da; // newest first
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Title order={3}>CardTrader – Paid Orders</Title>
          <Text size="sm" c="dimmed">
            Showing only orders with status <strong>PAID</strong> from the last
            N weeks.
          </Text>
        </Box>
        <Select
          label="Lookback"
          value={maxWeeks}
          onChange={(v) => v && setMaxWeeks(v)}
          data={[
            { value: "4", label: "Last 4 weeks" },
            { value: "8", label: "Last 8 weeks" },
            { value: "12", label: "Last 12 weeks" },
            { value: "52", label: "Last 52 weeks" },
          ]}
          maw={160}
        />
      </Group>

      {loading && (
        <Group justify="center" mt="md">
          <Loader size="sm" />
        </Group>
      )}

      {error && (
        <Alert
          color="red"
          icon={<IconAlertTriangle size={16} />}
          variant="light"
        >
          {error}
        </Alert>
      )}

      {!loading && !error && visibleOrders.length === 0 && (
        <Text size="sm" c="dimmed">
          No PAID orders found in this time window.
        </Text>
      )}

      {!loading && !error && visibleOrders.length > 0 && (
        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <Title order={4}>Paid Orders</Title>
              <Badge variant="light" size="sm">
                {visibleOrders.length} orders
              </Badge>
            </Group>
          </Group>

          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Code</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th ta="right">Cards</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
                <Table.Th ta="center">Allocated?</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visibleOrders.map((o) => {
                const dateText = o.createdAt
                  ? new Date(o.createdAt).toLocaleString()
                  : "—";

                // Prefer formattedTotal if present, else sellerTotalCents
                let totalText = "—";
                if (o.formattedTotal) {
                  totalText = o.formattedTotal;
                } else if (o.sellerTotalCents != null) {
                  const amt = (o.sellerTotalCents / 100).toFixed(2);
                  totalText = o.sellerTotalCurrency
                    ? `${amt} ${o.sellerTotalCurrency}`
                    : amt;
                }

                return (
                  <Table.Tr key={o.id}>
                    <Table.Td>{dateText}</Table.Td>
                    <Table.Td>{o.code || o.id}</Table.Td>
                    <Table.Td>{o.state || "—"}</Table.Td>
                    <Table.Td ta="right">{o.size ?? "—"}</Table.Td>
                    <Table.Td ta="right">{totalText}</Table.Td>
                    <Table.Td ta="center">
                      {o.allocated ? (
                        <Badge color="green" variant="light" size="sm">
                          Yes
                        </Badge>
                      ) : (
                        <Badge color="gray" variant="light" size="sm">
                          No
                        </Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}

