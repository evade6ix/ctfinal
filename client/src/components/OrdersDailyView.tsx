import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Loader,
  Pagination,
  Paper,
  ScrollArea,
  Stack,
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

// Line item coming back from /api/orders and /api/order-articles/:id
type OrderItem = {
  id?: number;
  cardTraderId?: number;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  set_name?: string; // e.g. "Ikoria: Lair of Behemoths"
  setCode?: string; // if you ever add this later
  binLocations?: { bin: string; row: number; quantity: number }[];
  image_url?: string;

  // 👇 pulled through from OrderAllocation in /api/order-articles
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
};

type DailySummary = {
  date: string; // "YYYY-MM-DD"
  totalOrders: number;
  totalValueCents: number;
  totalValue: string;
  orders: OrderSummary[];
};

type DailyAllocationRef = {
  orderId: string | number;
  cardTraderId?: number;
  picked?: boolean;
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
  image_url?: string;

  // 👇 which allocations this line represents
  allocations: DailyAllocationRef[];
  totalAllocations: number;
  pickedAllocations: number;

  // stable key for this bin/row/set/card group
  groupKey: string;
};

const API_BASE = "/api";
const PER_PAGE = 10;

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

  // date -> current page (for per-day pagination)
  const [pageByDate, setPageByDate] = useState<Record<string, number>>({});

  // key (bin|row|set|name) -> whether image is open
  const [imageOpenByKey, setImageOpenByKey] = useState<
    Record<string, boolean>
  >({});

  // which row is currently doing a bulk pick/unpick call
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  // which row is currently loading a Scryfall image
  const [imageLoadingKey, setImageLoadingKey] = useState<string | null>(null);

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
  //    NOTE: we use ?skipImages=1 so this DOES NOT spam Scryfall.
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
                `${API_BASE}/order-articles/${order.id}?skipImages=1`
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
                    image_url: it.image_url, // initial image (usually empty now)
                    allocations: [],
                    totalAllocations: 0,
                    pickedAllocations: 0,
                    groupKey: key,
                  };
                }

                const line = bucket[key];

                // fill in image once we get a real one (rare with skipImages=1, but harmless)
                if (!line.image_url && it.image_url) {
                  line.image_url = it.image_url;
                }

                // aggregate qty
                const qtyAdd = loc.quantity ?? it.quantity ?? 0;
                line.quantity = (line.quantity || 0) + qtyAdd;

                // track allocation references (per order line)
                line.allocations.push({
                  orderId: order.id,
                  cardTraderId: it.cardTraderId,
                  picked: !!it.picked,
                });

                line.totalAllocations += 1;
                if (it.picked) {
                  line.pickedAllocations += 1;
                }
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

  const toggleImageForKey = (key: string) => {
    setImageOpenByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // 👉 On-demand Scryfall image for a single aggregated line
  const handleShowImageForLine = async (line: DailyLine) => {
    if (!line.name) return;

    const rowKey = line.groupKey;
    setImageLoadingKey(rowKey);

    try {
      const res = await fetch(
        `${API_BASE}/order-articles/image?name=${encodeURIComponent(
          line.name
        )}`
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to fetch image for ${line.name}: ${res.status}`,
          txt.slice(0, 200)
        );
        return;
      }

      const json = (await res.json()) as { image_url?: string | null };
      if (!json.image_url) {
        console.warn("No image_url returned for", line.name);
        return;
      }

      // Update just that one line in dailyLinesByDate
      setDailyLinesByDate((prev) => {
        const dayLines = prev[line.date];
        if (!dayLines) return prev;

        const updatedDayLines = dayLines.map((l) =>
          l.groupKey === rowKey
            ? { ...l, image_url: json.image_url || l.image_url }
            : l
        );

        return {
          ...prev,
          [line.date]: updatedDayLines,
        };
      });
    } catch (err) {
      console.error("Error in handleShowImageForLine:", err);
    } finally {
      setImageLoadingKey(null);
    }
  };

  // bulk pick/unpick for a single aggregated line (no re-aggregation)
  const handleTogglePickedLine = async (line: DailyLine) => {
    const validAllocs = line.allocations.filter(
      (a) => typeof a.cardTraderId === "number"
    );
    if (!validAllocs.length) return;

    const allPicked =
      line.totalAllocations > 0 &&
      line.pickedAllocations === line.totalAllocations;

    const endpoint = allPicked ? "unpick" : "pick";

    setTogglingKey(line.groupKey);
    try {
      await Promise.all(
        validAllocs.map((alloc) =>
          fetch(`${API_BASE}/order-allocations/${endpoint}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: alloc.orderId,
              cardTraderId: alloc.cardTraderId,
              pickedBy: allPicked ? undefined : "DailyView",
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const txt = await res.text().catch(() => "");
              console.error(
                `Failed to ${endpoint} allocation`,
                alloc,
                res.status,
                txt.slice(0, 200)
              );
            }
          })
        )
      );

      // 🎯 NO FULL REBUILD: just update this line locally
      setDailyLinesByDate((prev) => {
        const dayLines = prev[line.date];
        if (!dayLines) return prev;

        const updatedDayLines = dayLines.map((l) => {
          if (l.groupKey !== line.groupKey) return l;

          const newPickedCount = allPicked ? 0 : l.totalAllocations;

          return {
            ...l,
            pickedAllocations: newPickedCount,
            allocations: l.allocations.map((a) => ({
              ...a,
              picked: !allPicked, // all picked or all unpicked
            })),
          };
        });

        return {
          ...prev,
          [line.date]: updatedDayLines,
        };
      });
    } finally {
      setTogglingKey(null);
    }
  };

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Daily Sales (Zero / HUB_PENDING)</Title>
          <Text c="dimmed" size="sm">
            Only CardTrader <strong>HUB_PENDING</strong> (Zero) orders,
            grouped by Toronto calendar day, with a bin / row / set / card
            picking list so you can pull cards every day instead of once per week.
            Pick / unpick per line is fully persistent via OrderAllocations.
            Images are loaded on demand per card.
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

          const totalPages = Math.max(
            1,
            Math.ceil(lines.length / PER_PAGE)
          );
          const currentPage = pageByDate[day.date] || 1;
          const safePage =
            currentPage > totalPages ? totalPages : currentPage;
          const startIndex = (safePage - 1) * PER_PAGE;
          const pageLines = lines.slice(
            startIndex,
            startIndex + PER_PAGE
          );

          return (
            <Box key={day.date} mt="lg">
              <Group justify="space-between" mb="xs">
                <Group gap="xs">
                  <Title order={3}>{day.date}</Title>
                  {lines.length > 0 && (
                    <Text size="xs" c="dimmed">
                      Showing {startIndex + 1}–
                      {Math.min(startIndex + PER_PAGE, lines.length)} of{" "}
                      {lines.length} lines
                    </Text>
                  )}
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
                        <Table.Th>Picked</Table.Th>
                        <Table.Th>Image</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {lines.length === 0 && (
                        <Table.Tr>
                          <Table.Td colSpan={7}>
                            <Text c="dimmed" size="sm">
                              No line items found for this day yet.
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      )}

                      {pageLines.map((line) => {
                        const rowKey = line.groupKey;
                        const isOpen = !!imageOpenByKey[rowKey];
                        const allPicked =
                          line.totalAllocations > 0 &&
                          line.pickedAllocations ===
                            line.totalAllocations;

                        return (
                          <Table.Tr key={rowKey}>
                            <Table.Td>
                              <Text>{line.bin}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text>{line.row ?? "-"}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text>
                                {line.setCode || line.set_name || "-"}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text>{line.name}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text>{line.quantity}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Stack gap={4}>
                                <Text size="xs" c="dimmed">
                                  Picked {line.pickedAllocations} /{" "}
                                  {line.totalAllocations}
                                </Text>
                                <Button
                                  size="xs"
                                  variant={allPicked ? "outline" : "filled"}
                                  color={allPicked ? "red" : "green"}
                                  loading={togglingKey === rowKey}
                                  onClick={() =>
                                    handleTogglePickedLine(line)
                                  }
                                >
                                  {allPicked
                                    ? "Unpick all"
                                    : "Mark all picked"}
                                </Button>
                              </Stack>
                            </Table.Td>
                            <Table.Td>
                              <Stack gap={4}>
                                <Button
                                  size="xs"
                                  variant="light"
                                  loading={imageLoadingKey === rowKey}
                                  onClick={async () => {
                                    if (!line.image_url) {
                                      await handleShowImageForLine(line);
                                    }
                                    toggleImageForKey(rowKey);
                                  }}
                                >
                                  {isOpen
                                    ? "Hide image"
                                    : line.image_url
                                    ? "View image"
                                    : "Load image"}
                                </Button>
                                {isOpen && (
                                  <Box mt={4}>
                                    <Image
                                      src={
                                        line.image_url ||
                                        "/card-placeholder.png"
                                      }
                                      alt={line.name}
                                      fit="contain"
                                      radius="md"
                                      w={220}
                                    />
                                  </Box>
                                )}
                              </Stack>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>

                {totalPages > 1 && (
                  <Group justify="flex-end" mt="sm">
                    <Pagination
                      size="sm"
                      value={safePage}
                      total={totalPages}
                      onChange={(page) =>
                        setPageByDate((prev) => ({
                          ...prev,
                          [day.date]: page,
                        }))
                      }
                    />
                  </Group>
                )}
              </Card>
            </Box>
          );
        })}
    </Box>
  );
}
