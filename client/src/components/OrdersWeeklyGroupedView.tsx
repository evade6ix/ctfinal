import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
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
  weekStart: string; // e.g. "2026-01-20"
  totalOrders: number;
  totalValueCents: number;
  totalValue?: string; // added in backend
  orders: ApiOrder[];
};

type OrderItem = {
  id?: number;
  cardTraderId?: number; // may map to blueprint id
  blueprintId?: number;  // if backend sends this later, we prefer it
  name?: string;
  quantity?: number;
  image_url?: string;
  set_name?: string;
  binLocations?: { bin: string; row: number; quantity: number }[];
};

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklySummary[]>([]);
  const [loading, setLoading] = useState(false);

  // 🔹 state for per-order card drilldown
  const [expandedOrderId, setExpandedOrderId] = useState<string | number | null>(
    null
  );
  const [itemsByOrder, setItemsByOrder] = useState<
    Record<string | number, OrderItem[]>
  >({});
  const [loadingItems, setLoadingItems] = useState(false);

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

  // 🔹 image selection with CardTrader fallback
  const getCardImageSrc = (it: OrderItem) => {
    // 1) Use explicit image_url if it looks valid
    if (it.image_url && it.image_url.startsWith("http")) {
      return it.image_url;
    }

    // 2) Otherwise, try blueprint/cardTrader id on CardTrader CDN
    const blueprintId = it.blueprintId ?? it.cardTraderId;
    if (blueprintId) {
      return `https://img.cardtrader.com/blueprints/${blueprintId}/front.jpg`;
    }

    // 3) Final fallback: Scryfall placeholder
    return "https://cards.scryfall.io/large/front/0/1/placeholder.jpg";
  };

  const loadItems = async (orderId: string | number) => {
    if (itemsByOrder[orderId]) {
      return; // already cached
    }

    try {
      setLoadingItems(true);
      const res = await fetch(`/api/order-articles/${orderId}`);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to load order items for ${orderId}: ${res.status}`,
          txt.slice(0, 300)
        );
        setItemsByOrder((prev) => ({ ...prev, [orderId]: [] }));
        return;
      }

      const data = (await res.json()) as OrderItem[];

      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: data,
      }));
    } catch (err) {
      console.error("Error loading order items", err);
      setItemsByOrder((prev) => ({ ...prev, [orderId]: [] }));
    } finally {
      setLoadingItems(false);
    }
  };

  const handleToggleOrder = (orderId: string | number) => {
    const willExpand = expandedOrderId !== orderId;
    setExpandedOrderId(willExpand ? orderId : null);
    if (willExpand) {
      loadItems(orderId);
    }
  };

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. All PAID orders combined. Click an order to
        see its cards sorted by bin and row.
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
                      <Table.Th></Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {paidOrders.map((o) => (
                      <>
                        {/* MAIN ORDER ROW */}
                        <Table.Tr
                          key={o.id}
                          style={{ cursor: "pointer" }}
                          onClick={() => handleToggleOrder(o.id)}
                        >
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
                          <Table.Td>
                            <Button
                              size="xs"
                              variant="light"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleOrder(o.id);
                              }}
                            >
                              {expandedOrderId === o.id
                                ? "Hide cards"
                                : "View cards"}
                            </Button>
                          </Table.Td>
                        </Table.Tr>

                        {/* EXPANDED CARDS ROW */}
                        {expandedOrderId === o.id && (
                          <Table.Tr key={`${o.id}-expanded`}>
                            <Table.Td
                              colSpan={5}
                              style={{
                                background: "#111",
                                padding: 0,
                                borderTop: "2px solid #333",
                              }}
                            >
                              <Box p="md">
                                {loadingItems && !itemsByOrder[o.id] && (
                                  <Group justify="center" p="lg">
                                    <Loader size="sm" />
                                  </Group>
                                )}

                                {itemsByOrder[o.id] &&
                                  itemsByOrder[o.id].length === 0 &&
                                  !loadingItems && (
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
                                            {/* IMAGE */}
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
                                                  "https://cards.scryfall.io/large/front/0/1/placeholder.jpg";
                                              }}
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
                                                    <Badge
                                                      key={i}
                                                      color="yellow"
                                                    >
                                                      {b.bin ?? "?"} / Row{" "}
                                                      {b.row ?? "?"} (x
                                                      {b.quantity ?? "?"})
                                                    </Badge>
                                                  )
                                                )}
                                              </Group>
                                            </Box>
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
