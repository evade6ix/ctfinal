import { useEffect, useState } from "react";
import {
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

type ApiOrder = {
  id: number | string;
  code?: string;
  state?: string | null;
  createdAt?: string | null;
  formattedTotal?: string | null;
};

type WeeklySummary = {
  weekStart: string;          // e.g. "2026-01-20"
  totalOrders: number;
  totalValueCents: number;
  totalValue?: string;        // added in backend
  orders: ApiOrder[];
};

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklySummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const weeklyRes = await fetch("/api/orders-weekly");
        const weeklyJson = await weeklyRes.json();
        setData(Array.isArray(weeklyJson) ? weeklyJson : []);
      } catch (err) {
        console.error("Failed to load /api/orders-weekly:", err);
        setData([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const formatWeekLabel = (weekStart: string) => {
    const start = new Date(weekStart);
    if (isNaN(start.getTime())) return weekStart;

    const end = new Date(start);
    end.setDate(start.getDate() + 6); // 7-day window

    const startStr = start.toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const endStr = end.toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    return `${startStr} – ${endStr}`;
  };

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. All orders & all cards combined.
      </Text>

      {loading && (
        <Group justify="center" mt="xl">
          <Loader size="lg" />
        </Group>
      )}

      {!loading && data.length === 0 && (
        <Text size="sm" c="dimmed">
          No weekly data available.
        </Text>
      )}

      {!loading &&
        data.map((week) => {
          const label = formatWeekLabel(week.weekStart);
          const paidOrders = (week.orders || []).filter(
            (o) => String(o.state || "").toLowerCase() === "paid"
          );

          return (
            <Paper
              key={week.weekStart}
              p="md"
              radius="md"
              withBorder
              style={{ background: "var(--mantine-color-dark-7)" }}
            >
              {/* HEADER */}
              <Group justify="space-between" mb="sm">
                <Stack gap={2}>
                  <Text fw={600} size="lg">
                    {label}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Week starting {week.weekStart}
                  </Text>
                </Stack>

                <Group gap="xs">
                  <Badge variant="filled" color="gray">
                    {week.totalOrders} orders
                  </Badge>
                  <Badge variant="filled" color="yellow">
                    {week.totalValue ?? (week.totalValueCents / 100).toFixed(2)}
                  </Badge>
                </Group>
              </Group>

              {/* PAID ORDERS IN THIS WEEK */}
              {paidOrders.length > 0 ? (
                <Table
                  withTableBorder
                  withColumnBorders
                  striped
                  highlightOnHover
                  styles={{
                    table: {
                      background: "var(--mantine-color-dark-7)",
                    },
                    th: {
                      background: "var(--mantine-color-dark-6)",
                    },
                  }}
                >
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Order Code</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Created</Table.Th>
                      <Table.Th>Total</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {paidOrders.map((o) => (
                      <Table.Tr key={o.id}>
                        <Table.Td>{o.code}</Table.Td>
                        <Table.Td>
                          <Badge color="green" variant="filled" size="xs">
                            {String(o.state || "").toUpperCase()}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {o.createdAt
                            ? new Date(o.createdAt).toLocaleString("en-CA", {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : "-"}
                        </Table.Td>
                        <Table.Td>{o.formattedTotal ?? "-"}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm" c="dimmed">
                  No PAID orders in this week.
                </Text>
              )}
            </Paper>
          );
        })}
    </Stack>
  );
}
