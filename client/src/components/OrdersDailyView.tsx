import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Card,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Table,
  Text,
  Title,
} from "@mantine/core";

type OrderSummary = {
  id: number | string;
  code?: string;
  state?: string | null;
  orderAs?: string | null;
  createdAt?: string | null;
  formattedTotal?: string | null;

  sellerTotalCents?: number | null;
  sellerTotalCurrency?: string | null;
};

type DailySummary = {
  date: string; // "YYYY-MM-DD"
  totalOrders: number;
  totalValueCents: number;
  totalValue: string;
  orders: OrderSummary[];
};

// Line item coming back from /api/order-articles/:id
type OrderItem = {
  id?: number;
  cardTraderId?: number;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  set_name?: string; // e.g. "Ikoria: Lair of Behemoths"
  setCode?: string;  // if you ever add this later
  binLocations?: { bin: string; row: number; quantity: number }[];
};

// Aggregated daily picking line
type DailyLine = {
  date: string;
  name: string;
  set_name?: string;
  setCode?: string;
  bin: string;
  row?: number;
  quantity: number;
};

const API_BASE = "/api";

// 👉 Helper: get YYYY-MM-DD in America/Toronto
function getTorontoDateKey(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", {
    timeZone: "America/Toronto",
  }); // "YYYY-MM-DD"
}

// 👉 Sorting helper: Bin → Row → Set → Card name
function sortDailyLines(lines: DailyLine[]): DailyLine[] {
  return [...lines].sort((a, b) => {
    // 1) Bin (string, numeric-aware)
    const aBin = (a.bin || "").toString();
    const bBin = (b.bin || "").toString();
    if (aBin !== bBin) {
      return aBin.localeCompare(bBin, undefined, { numeric: true });
    }

    // 2) Row (ascending; unassigned rows at bottom)
    const aRow = a.row ?? Number.MAX_SAFE_INTEGER;
    const bRow = b.row ?? Number.MAX_SAFE_INTEGER;
    if (aRow !== bRow) {
      return aRow - bRow;
    }

    // 3) Set (prefer setCode, fallback to set_name)
    const aSet = (a.setCode || a.set_name || "").toString().toLowerCase();
    const bSet = (b.setCode || b.set_name || "").toString().toLowerCase();
    if (aSet !== bSet) {
      return aSet.localeCompare(bSet, undefined, { numeric: true });
    }

    // 4) Card name A–Z
    const aName = (a.name || "").toString().toLowerCase();
    const bName = (b.name || "").toString().toLowerCase();
    return aName.localeCompare(bName, undefined, { numeric: true });
  });
}

export function OrdersDailyView() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // date -> header stats (orders + total value)
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);
  // date -> aggregated picking lines for that date
  const [dailyLinesByDate, setDailyLinesByDate] = useState<
    Record<string, DailyLine[]>
  >({});

  // 1) Fetch all orders from /api/orders (same as OrdersView)
  useEffect(() => {
    async function fetchOrders() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`${API_BASE}/orders`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data: OrderSummary[] = await res.json();
        setOrders(data || []);
      } catch (err: any) {
        console.error("Failed to fetch orders:", err);
        setError(err?.message ?? "Failed to fetch orders");
      } finally {
        setLoading(false);
      }
    }

    fetchOrders();
  }, []);

  // 2) Build per-day header stats (order count + total C$)
  useEffect(() => {
    // Only use Zero / hub_pending status
    const zeroOrders = orders.filter(
      (o) => o.state && o.state.toUpperCase() === "HUB_PENDING"
    );

    if (!zeroOrders.length) {
      setDailySummaries([]);
      return;
    }

    const map = new Map<
      string,
      { totalOrders: number; totalValueCents: number; orders: OrderSummary[] }
    >();

    for (const order of zeroOrders) {
      const dateKey = getTorontoDateKey(order.createdAt);
      if (!dateKey) continue;

      // Try formattedTotal first, fallback to sellerTotalCents
      let cents = 0;
      if (order.formattedTotal) {
        const cleaned = order.formattedTotal.replace(/[^\d.,-]/g, "");
        const normalized = cleaned.replace(",", ".");
        const num = parseFloat(normalized);
        if (!Number.isNaN(num)) {
          cents = Math.round(num * 100);
        }
      } else if (order.sellerTotalCents) {
        cents = order.sellerTotalCents;
      }

      if (!map.has(dateKey)) {
        map.set(dateKey, {
          totalOrders: 0,
          totalValueCents: 0,
          orders: [],
        });
      }

      const bucket = map.get(dateKey)!;
      bucket.totalOrders += 1;
      bucket.totalValueCents += cents;
      bucket.orders.push(order);
    }

    const result: DailySummary[] = Array.from(map.entries())
      .map(([date, bucket]) => ({
        date,
        totalOrders: bucket.totalOrders,
        totalValueCents: bucket.totalValueCents,
        totalValue: `C$${(bucket.totalValueCents / 100).toFixed(2)}`,
        orders: bucket.orders,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest date first

    setDailySummaries(result);
  }, [orders]);

  // 3) For each hub_pending order, fetch /api/order-articles/:id and aggregate per day
  useEffect(() => {
    async function buildDailyLines() {
      const zeroOrders = orders.filter(
        (o) => o.state && o.state.toUpperCase() === "HUB_PENDING"
      );

      if (!zeroOrders.length) {
        setDailyLinesByDate({});
        return;
      }

      setLinesLoading(true);
      try {
        // Intermediate: date -> key -> DailyLine
        const byDate: Record<string, Record<string, DailyLine>> = {};

        await Promise.all(
          zeroOrders.map(async (order) => {
            const dateKey = getTorontoDateKey(order.createdAt);
            if (!dateKey) return;

            let items: OrderItem[] = [];
            try {
              const res = await fetch(
                `${API_BASE}/order-articles/${order.id}`
              );
              if (!res.ok) {
                console.error(
                  "order-articles failed for",
                  order.id,
                  res.status
                );
                return;
              }
              items = await res.json();
            } catch (err) {
              console.error(
                "Failed to fetch order-articles for order",
                order.id,
                err
              );
              return;
            }

            if (!byDate[dateKey]) {
              byDate[dateKey] = {};
            }
            const bucket = byDate[dateKey];

            for (const it of items) {
              const name = it.name || "Unknown card";
              const setCode = it.setCode;
              const setName = it.set_name || "";
              const setKey = (setCode || setName || "").toString();

              // Use binLocations if present; otherwise treat as unassigned
              const binLocs =
                it.binLocations && it.binLocations.length > 0
                  ? it.binLocations
                  : [
                      {
                        bin: "(unassigned)",
                        row: undefined as unknown as number,
                        quantity: it.quantity ?? 0,
                      },
                    ];

              for (const loc of binLocs) {
                const binLabel = (loc.bin ?? "(unassigned)").toString();
                const rowVal = loc.row;

                const key = `${binLabel}|${rowVal ?? 0}|${setKey}|${name}`;

                if (!bucket[key]) {
                  bucket[key] = {
                    date: dateKey,
                    name,
                    set_name: setName,
                    setCode,
                    bin: binLabel,
                    row: typeof rowVal === "number" ? rowVal : undefined,
                    quantity: 0,
                  };
                }

                const qtyAdd = loc.quantity ?? it.quantity ?? 0;
                bucket[key].quantity =
                  (bucket[key].quantity || 0) + qtyAdd;
              }
            }
          })
        );

        const final: Record<string, DailyLine[]> = {};
        Object.entries(byDate).forEach(([date, map]) => {
          final[date] = sortDailyLines(Object.values(map));
        });

        setDailyLinesByDate(final);
      } finally {
        setLinesLoading(false);
      }
    }

    buildDailyLines();
  }, [orders]);

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Daily Sales (Zero / HUB_PENDING)</Title>
          <Text c="dimmed" size="sm">
            Only CardTrader <strong>HUB_PENDING</strong> (Zero) orders,
            grouped by Toronto calendar day, with a bin / row / set / card
            picking list so you can pull cards every day instead of once per week.
          </Text>
        </div>
      </Group>

      {loading && (
        <Group justify="center" mt="lg">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Loading daily summaries…
          </Text>
        </Group>
      )}

      {error && !loading && (
        <Paper withBorder radius="md" p="md" mt="md">
          <Text c="red" fw={500}>
            Error
          </Text>
          <Text size="sm" c="red">
            {error}
          </Text>
        </Paper>
      )}

      {!loading && !error && dailySummaries.length === 0 && (
        <Text c="dimmed" mt="md">
          No <strong>HUB_PENDING</strong> orders found.
        </Text>
      )}

      {linesLoading && (
        <Group justify="center" mt="sm">
          <Loader size="xs" />
          <Text c="dimmed" size="xs">
            Building daily picking lists…
          </Text>
        </Group>
      )}

      {!loading &&
        !error &&
        dailySummaries.map((day) => {
          const lines = dailyLinesByDate[day.date] || [];

          return (
            <Box key={day.date} mt="lg">
              <Group justify="space-between" mb="xs">
                <Group gap="xs">
                  <Title order={3}>{day.date}</Title>
                </Group>
                <Group gap="xs">
                  <Badge variant="light">
                    Orders: {day.totalOrders}
                  </Badge>
                  <Badge variant="light">
                    Total: {day.totalValue}
                  </Badge>
                </Group>
              </Group>

              <Card withBorder radius="lg">
                <ScrollArea>
                  <Table striped highlightOnHover withColumnBorders>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Bin</Table.Th>
                        <Table.Th>Row</Table.Th>
                        <Table.Th>Set</Table.Th>
                        <Table.Th>Card</Table.Th>
                        <Table.Th>Qty</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {lines.length === 0 && (
                        <Table.Tr>
                          <Table.Td colSpan={5}>
                            <Text c="dimmed" size="sm">
                              No line items found for this day yet.
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      )}

                      {lines.map((line, idx) => (
                        <Table.Tr
                          key={`${line.bin}-${line.row}-${line.setCode || line.set_name}-${line.name}-${idx}`}
                        >
                          <Table.Td>
                            <Text>{line.bin}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text>{line.row ?? "-"}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text>{line.setCode || line.set_name || "-"}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text>{line.name}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text>{line.quantity}</Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              </Card>
            </Box>
          );
        })}
    </Box>
  );
}
