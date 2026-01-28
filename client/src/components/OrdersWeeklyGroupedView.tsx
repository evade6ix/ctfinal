import { useEffect, useState } from "react";
import {
  Accordion,
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Image,
} from "@mantine/core";

type WeeklyResponse = {
  key: string;
  from: string;
  to: string;
  label: string;
  cardmap: {
    [blueprintId: string]: {
      blueprintId: number;
      name: string;
      expansion: string;
      totalQuantity: number;
      // 👇 optional bin / row if backend sends them
      bin?: number | string | null;
      row?: number | string | null;
      items: {
        orderId: number | string;
        code: string;
        quantity: number;
      }[];
    };
  };
};

// 👇 summary type for /api/orders
type OrderSummary = {
  id: number | string;
  code: string;
  state?: string | null;
  createdAt?: string | null;
  formattedTotal?: string | null;
};

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklyResponse[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // 🔄 pull weekly cardmap + raw orders
        const [weeklyRes, ordersRes] = await Promise.all([
          fetch("/api/orders-weekly"),
          fetch("/api/orders"),
        ]);

        const weeklyJson = await weeklyRes.json();
        const ordersJson = await ordersRes.json();

        setData(Array.isArray(weeklyJson) ? weeklyJson : []);
        setOrders(Array.isArray(ordersJson) ? ordersJson : []);
      } catch (err) {
        console.error("Failed to load weekly / orders:", err);
        setData([]);
        setOrders([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

      {!loading &&
        data.map((week) => {
          // 🔢 sort cards by bin first, then row, then totalQuantity desc
          const rows = Object.values(week.cardmap).sort((a, b) => {
            const parseNum = (v: unknown) => {
              if (typeof v === "number") return v;
              if (typeof v === "string") {
                const n = parseInt(v, 10);
                return isNaN(n) ? 0 : n;
              }
              return 0;
            };

            const binA = parseNum(a.bin);
            const binB = parseNum(b.bin);
            if (binA !== binB) return binA - binB;

            const rowA = parseNum(a.row);
            const rowB = parseNum(b.row);
            if (rowA !== rowB) return rowA - rowB;

            // fallback: highest totalQuantity first
            return b.totalQuantity - a.totalQuantity;
          });

          // 🔎 PAID orders that fall inside this week's [from, to] window
          const paidOrders = orders.filter((o) => {
            if (!o.createdAt) return false;
            if (String(o.state || "").toLowerCase() !== "paid") return false;

            const t = new Date(o.createdAt).getTime();
            const fromTs = week.from ? new Date(week.from).getTime() : NaN;
            const toTs = week.to ? new Date(week.to).getTime() : NaN;

            if (isNaN(t) || isNaN(fromTs) || isNaN(toTs)) return false;

            return t >= fromTs && t <= toTs;
          });

          return (
            <Paper
              key={week.key}
              p="md"
              radius="md"
              withBorder
              style={{ background: "var(--mantine-color-dark-7)" }}
            >
              {/* HEADER */}
              <Group justify="space-between" mb="sm">
                <Text fw={600} size="lg">
                  {week.label}
                </Text>
                <Badge variant="filled" color="gray">
                  {rows.length} cards
                </Badge>
              </Group>

              {/* PAID ORDERS IN THIS WEEK (e.g. Ct connect shipment) */}
              {paidOrders.length > 0 && (
                <Stack gap={4} mb="sm">
                  <Text size="sm" fw={500}>
                    Paid orders in this window
                  </Text>
                  <Table
                    withTableBorder
                    withColumnBorders
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
                              ? new Date(o.createdAt).toLocaleString()
                              : "-"}
                          </Table.Td>
                          <Table.Td>{o.formattedTotal ?? "-"}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Stack>
              )}

              {/* ACCORDION */}
              <Accordion
                variant="separated"
                multiple
                styles={{
                  item: {
                    background: "var(--mantine-color-dark-6)",
                    borderRadius: 8,
                    border: "1px solid var(--mantine-color-dark-4)",
                  },
                  control: {
                    padding: "10px 14px",
                  },
                  panel: {
                    background: "var(--mantine-color-dark-7)",
                    padding: "12px 16px",
                  },
                }}
              >
                {rows.map((c) => (
                  <Accordion.Item
                    key={c.blueprintId}
                    value={String(c.blueprintId)}
                  >
                    <Accordion.Control>
                      <Group gap="md">
                        <Image
                          w={40}
                          h={56}
                          fit="contain"
                          radius="sm"
                          src={`https://img.cardtrader.com/blueprints/${c.blueprintId}/front.jpg`}
                        />
                        <Stack gap={0}>
                          <Text fw={500}>{c.name}</Text>
                          <Text size="xs" c="dimmed">
                            {c.expansion}
                          </Text>
                          {/* Optional bin/row display if provided */}
                          {(c.bin != null || c.row != null) && (
                            <Text size="xs" c="dimmed">
                              Bin {c.bin ?? "?"} · Row {c.row ?? "?"}
                            </Text>
                          )}
                        </Stack>
                      </Group>
                    </Accordion.Control>

                    <Accordion.Panel>
                      <Stack gap="sm">
                        <Text fw={500}>
                          Total needed:{" "}
                          <Badge color="yellow" variant="filled">
                            {c.totalQuantity}
                          </Badge>
                        </Text>

                        <Table
                          striped
                          withTableBorder
                          withColumnBorders
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
                              <Table.Th>Order</Table.Th>
                              <Table.Th>Quantity</Table.Th>
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {c.items.map((i, idx) => (
                              <Table.Tr key={idx}>
                                <Table.Td>{i.code}</Table.Td>
                                <Table.Td>{i.quantity}</Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            </Paper>
          );
        })}
    </Stack>
  );
}
