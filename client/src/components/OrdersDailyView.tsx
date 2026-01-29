import { useEffect, useMemo, useState } from "react";
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

type ApiOrder = {
  id: number | string;
  code?: string;
  state?: string | null;
  createdAt?: string | null;
  formattedTotal?: string | null;
};

type WeeklySummary = {
  weekStart: string; // e.g. "2026-01-20"
  totalOrders: number;
  totalValueCents: number;
  totalValue?: string; // added in backend
  orders: ApiOrder[];
};

type DailySummary = {
  date: string; // "YYYY-MM-DD"
  totalOrders: number;
  totalValueCents: number;
  totalValue: string;
  orders: ApiOrder[];
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
  // extra fields if needed later
  [key: string]: any;
};

const API_BASE = "/api";

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
  const [weeklyData, setWeeklyData] = useState<WeeklySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // date -> aggregated picking lines for that date
  const [dailyLinesByDate, setDailyLinesByDate] = useState<
    Record<string, DailyLine[]>
  >({});

  // 1) Fetch the same data the Weekly view uses: /api/orders-weekly
  useEffect(() => {
    async function fetchWeekly() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`${API_BASE}/orders-weekly`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data: WeeklySummary[] = await res.json();
        setWeeklyData(data || []);
      } catch (err: any) {
        console.error("Failed to fetch weekly orders:", err);
        setError(err?.message ?? "Failed to fetch weekly orders");
      } finally {
        setLoading(false);
      }
    }

    fetchWeekly();
  }, []);

  // 2) Build daily summaries for header stats (orders + total $ per day)
  const dailySummaries: DailySummary[] = useMemo(() => {
    const map = new Map<
      string,
      { totalOrders: number; totalValueCents: number; orders: ApiOrder[] }
    >();

    const allOrders: ApiOrder[] = weeklyData.flatMap((w) => w.orders || []);

    for (const order of allOrders) {
      if (!order.createdAt) continue;

      const dateKey = new Date(order.createdAt).toISOString().slice(0, 10); // "YYYY-MM-DD"

      // Try to parse value from formattedTotal like "C$0.88"
      let cents = 0;
      if (order.formattedTotal) {
        const cleaned = order.formattedTotal.replace(/[^\d.,-]/g, "");
        const normalized = cleaned.replace(",", ".");
        const num = parseFloat(normalized);
        if (!Number.isNaN(num)) {
          cents = Math.round(num * 100);
        }
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

    // Turn map → array, sort by date desc
    const result: DailySummary[] = Array.from(map.entries())
      .map(([date, bucket]) => ({
        date,
        totalOrders: bucket.totalOrders,
        totalValueCents: bucket.totalValueCents,
        totalValue: `C$${(bucket.totalValueCents / 100).toFixed(2)}`,
        orders: bucket.orders,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return result;
  }, [weeklyData]);

  // 3) For each order, fetch /api/order-articles/:id and aggregate per day
  useEffect(() => {
    async function buildDailyLines() {
      if (!weeklyData.length) return;

      setLinesLoading(true);
      try {
        const allOrders: ApiOrder[] = weeklyData.flatMap(
          (w) => w.orders || []
        );

        // Intermediate: date -> key -> DailyLine
        const byDate: Record<string, Record<string, DailyLine>> = {};

        await Promise.all(
          allOrders.map(async (order) => {
            if (!order.createdAt) return;

            const dateKey = new Date(order.createdAt)
              .toISOString()
              .slice(0, 10); // "YYYY-MM-DD"

            let items: OrderItem[] = [];
            try {
              const res = await fetch(
                `${API_BASE}/order-articles/${order.id}`
              );
              if (!res.ok) {
                // don't blow up the whole day if one order fails
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
  }, [weeklyData]);

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Daily Sales (CardTrader Zero)</Title>
          <Text c="dimmed" size="sm">
            Same orders as the weekly Zero view, regrouped by calendar day,
            with a bin / row / set / card picking list so you can pull cards
            every day.
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
          No orders found in the weekly Zero window.
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
