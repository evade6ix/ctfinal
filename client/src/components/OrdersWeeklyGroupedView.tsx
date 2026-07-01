import { Fragment, useEffect, useState } from "react";
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
  id: number;
  code?: string;
  state?: string | null;
  createdAt?: string | null;
  formattedTotal?: string | null;
};

type WeeklySummary = {
  shipmentId?: string;
  weekStart: string;
  shipmentDate?: string;
  totalOrders: number;
  totalValueCents: number;
  totalValue?: string;
  orders: ApiOrder[];
};

type OrderItem = {
  id?: number | string;
  cardTraderId?: number | null;
  blueprintId?: number | null;
  name?: string;
  quantity?: number;
  image_url?: string | null;
  set_name?: string | null;
  binLocations?: { bin: string; row: number; quantity: number }[];
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  isFoil?: boolean;
  condition?: string | null;
};

type FilterMode = "all" | "picked" | "unpicked";

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | number | null>(
    null
  );
  const [itemsByOrder, setItemsByOrder] = useState<
    Record<string | number, OrderItem[]>
  >({});
  const [loadingItems, setLoadingItems] = useState(false);
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

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

    if (Number.isNaN(start.getTime())) return weekStart;

    const end = new Date(start);
    end.setDate(start.getDate() + 6);

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

  const sortOrderItems = (items: OrderItem[]): OrderItem[] => {
    return [...items].sort((a, b) => {
      const aHasBin = !!(a.binLocations && a.binLocations.length > 0);
      const bHasBin = !!(b.binLocations && b.binLocations.length > 0);

      if (aHasBin && !bHasBin) return -1;
      if (!aHasBin && bHasBin) return 1;

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

        if (aRow !== bRow) return aRow - bRow;
      }

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

  const getCardImageSrc = (it: OrderItem) => {
    if (
      it.image_url &&
      typeof it.image_url === "string" &&
      it.image_url.startsWith("http")
    ) {
      return it.image_url;
    }

    return "/card-placeholder.png";
  };

  const filterItems = (items: OrderItem[], mode: FilterMode): OrderItem[] => {
    if (mode === "picked") return items.filter((it) => !!it.picked);
    if (mode === "unpicked") return items.filter((it) => !it.picked);
    return items;
  };

  const loadItems = async (orderId: string | number) => {
    if (itemsByOrder[orderId]) return;

    try {
      setLoadingItems(true);
      const res = await fetch(`/api/order-articles/${orderId}?skipImages=1`);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to load order items for ${orderId}: ${res.status}`,
          txt.slice(0, 300)
        );
        setItemsByOrder((prev) => ({ ...prev, [orderId]: [] }));
        return;
      }

      const loadedItems = (await res.json()) as OrderItem[];
      const sorted = sortOrderItems(Array.isArray(loadedItems) ? loadedItems : []);

      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: sorted,
      }));
    } catch (err) {
      console.error("Error loading order items", err);
      setItemsByOrder((prev) => ({ ...prev, [orderId]: [] }));
    } finally {
      setLoadingItems(false);
    }
  };

  const handleToggleOrder = (order: ApiOrder) => {
    const orderId = Number(order.id);

    if (!Number.isFinite(orderId)) {
      console.error("Invalid numeric CardTrader order id:", order);
      return;
    }

    const willExpand = expandedOrderId !== orderId;
    setExpandedOrderId(willExpand ? orderId : null);

    if (willExpand) loadItems(orderId);
  };

  const handleShowImage = async (
    orderId: string | number,
    index: number,
    item: OrderItem
  ) => {
    const name = item.name;
    if (!name) return;

    try {
      const res = await fetch(
        `/api/order-articles/image?name=${encodeURIComponent(name)}`
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(
          `Failed to fetch image for ${name}: ${res.status}`,
          txt.slice(0, 200)
        );
        return;
      }

      const json = (await res.json()) as { image_url?: string | null };
      if (!json.image_url) return;

      setItemsByOrder((prev) => {
        const existing = prev[orderId];
        if (!existing) return prev;

        const clone = [...existing];
        const original = clone[index];
        if (!original) return prev;

        clone[index] = {
          ...original,
          image_url: json.image_url,
        };

        return {
          ...prev,
          [orderId]: clone,
        };
      });
    } catch (err) {
      console.error("Error in handleShowImage:", err);
    }
  };

  async function persistPick(
    orderId: string | number,
    index: number,
    item: OrderItem
  ) {
    const key = `${orderId}-${item.cardTraderId ?? `idx-${index}`}`;
    setPickingKey(key);

    try {
      if (item.cardTraderId) {
        const res = await fetch("/api/order-allocations/pick", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId,
            orderItemId: item.id,
            cardTraderId: item.cardTraderId,
            pickedBy: "local",
          }),
        });

        if (!res.ok) {
          console.error("Failed picking", await res.text());
        }
      }

      setItemsByOrder((prev) => {
        const arr = prev[orderId];
        if (!arr) return prev;

        const clone = [...arr];
        if (!clone[index]) return prev;

        clone[index] = {
          ...clone[index],
          picked: true,
          pickedAt: new Date().toISOString(),
        };

        return { ...prev, [orderId]: clone };
      });
    } finally {
      setPickingKey(null);
    }
  }

  async function persistUnpick(
    orderId: string | number,
    index: number,
    item: OrderItem
  ) {
    const key = `${orderId}-${item.cardTraderId ?? `idx-${index}`}`;
    setPickingKey(key);

    try {
      if (item.cardTraderId) {
        const res = await fetch("/api/order-allocations/unpick", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId,
            orderItemId: item.id,
            cardTraderId: item.cardTraderId,
          }),
        });

        if (!res.ok) {
          console.error("Failed unpicking", await res.text());
        }
      }

      setItemsByOrder((prev) => {
        const arr = prev[orderId];
        if (!arr) return prev;

        const clone = [...arr];
        if (!clone[index]) return prev;

        clone[index] = {
          ...clone[index],
          picked: false,
          pickedAt: null,
        };

        return { ...prev, [orderId]: clone };
      });
    } finally {
      setPickingKey(null);
    }
  }

  async function handleMarkFulfilledUpTo(orderId: string | number, index: number) {
    const items = itemsByOrder[orderId] || [];

    for (let i = 0; i <= index; i++) {
      const item = items[i];
      if (item && !item.picked) {
        // eslint-disable-next-line no-await-in-loop
        await persistPick(orderId, i, item);
      }
    }
  }

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. The live consolidated CT Zero shipment appears
        once CardTrader creates the paid shipment order. Click an order to see
        its cards sorted by bin and row. Images load on demand. Picked lines are
        stored in Mongo and shared with your other views.
      </Text>

      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Filter lines:
        </Text>
        <Button
          size="xs"
          variant={filterMode === "all" ? "filled" : "subtle"}
          onClick={() => setFilterMode("all")}
        >
          All
        </Button>
        <Button
          size="xs"
          variant={filterMode === "unpicked" ? "filled" : "subtle"}
          color="yellow"
          onClick={() => setFilterMode("unpicked")}
        >
          Unpicked
        </Button>
        <Button
          size="xs"
          variant={filterMode === "picked" ? "filled" : "subtle"}
          color="green"
          onClick={() => setFilterMode("picked")}
        >
          Picked
        </Button>
      </Group>

      {loading && (
        <Group justify="center" mt="xl">
          <Loader size="lg" />
        </Group>
      )}

      {!loading && data.length === 0 && (
        <Text size="sm" c="dimmed">
          No live paid CT Zero shipment available yet.
        </Text>
      )}

      {!loading &&
        data.map((week) => {
          const label = formatWeekLabel(week.weekStart);
          const shipmentOrders = (week.orders || []).filter((o) => {
            const state = String(o.state || "").toLowerCase();
            return state === "paid";
          });

          return (
            <Paper
              key={week.shipmentId || week.weekStart}
              p="md"
              radius="md"
              withBorder
              style={{ background: "var(--mantine-color-dark-7)" }}
            >
              <Group justify="space-between" mb="sm">
                <Stack gap={2}>
                  <Text fw={600} size="lg">
                    {label}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Shipment date {week.shipmentDate || week.weekStart}
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

              {shipmentOrders.length > 0 ? (
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
                    {shipmentOrders.map((o) => (
                      <Fragment key={o.id}>
                        <Table.Tr
                          style={{ cursor: "pointer" }}
                          onClick={() => handleToggleOrder(o)}
                        >
                          <Table.Td>{o.code || o.id}</Table.Td>
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
                                handleToggleOrder(o);
                              }}
                            >
                              {expandedOrderId === o.id
                                ? "Hide cards"
                                : "View cards"}
                            </Button>
                          </Table.Td>
                        </Table.Tr>

                        {expandedOrderId === o.id && (
                          <Table.Tr>
                            <Table.Td
                              colSpan={5}
                              style={{
                                background: "#111",
                                padding: 0,
                                borderTop: "2px solid #333",
                              }}
                            >
                              <Box p="md">
                                {!itemsByOrder[o.id] && loadingItems && (
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
                                  itemsByOrder[o.id].length > 0 &&
                                  (() => {
                                    const allItems = itemsByOrder[o.id]!;
                                    const visibleItems = filterItems(
                                      allItems,
                                      filterMode
                                    );

                                    if (
                                      visibleItems.length === 0 &&
                                      !loadingItems
                                    ) {
                                      return (
                                        <Text c="dimmed" ta="center">
                                          No line items match the current filter.
                                        </Text>
                                      );
                                    }

                                    return (
                                      <Stack gap="md">
                                        {visibleItems.map((it) => {
                                          const isPicked = !!it.picked;
                                          const originalIndex = allItems.indexOf(it);
                                          const key = `${o.id}-${
                                            it.cardTraderId ?? `idx-${originalIndex}`
                                          }`;
                                          const isBusy =
                                            pickingKey ===
                                            `${o.id}-${
                                              it.cardTraderId ?? `idx-${originalIndex}`
                                            }`;

                                          return (
                                            <Group
                                              key={key}
                                              align="flex-start"
                                              wrap="nowrap"
                                              style={{
                                                padding: "8px 12px",
                                                borderBottom: "1px solid #333",
                                                background: isPicked
                                                  ? "rgba(46, 204, 113, 0.12)"
                                                  : "transparent",
                                                borderLeft: isPicked
                                                  ? "3px solid #2ecc71"
                                                  : "3px solid transparent",
                                                borderRadius: 4,
                                              }}
                                            >
                                              <Box
                                                style={{
                                                  display: "flex",
                                                  flexDirection: "column",
                                                  alignItems: "center",
                                                  marginRight: 16,
                                                }}
                                              >
                                                <img
                                                  src={getCardImageSrc(it)}
                                                  width={140}
                                                  height={196}
                                                  style={{
                                                    objectFit: "cover",
                                                    borderRadius: 6,
                                                  }}
                                                  loading="lazy"
                                                  decoding="async"
                                                  onError={(e) => {
                                                    (
                                                      e.target as HTMLImageElement
                                                    ).src = "/card-placeholder.png";
                                                  }}
                                                  alt={it.name || "Card image"}
                                                />
                                                <Button
                                                  mt={6}
                                                  size="xs"
                                                  variant="subtle"
                                                  onClick={() =>
                                                    handleShowImage(
                                                      o.id,
                                                      originalIndex,
                                                      it
                                                    )
                                                  }
                                                >
                                                  Show image
                                                </Button>
                                              </Box>

                                              <Box
                                                style={{
                                                  flex: 1,
                                                  display: "flex",
                                                  flexDirection: "column",
                                                  gap: 6,
                                                }}
                                              >
                                                <Group
                                                  justify="space-between"
                                                  align="flex-start"
                                                  wrap="nowrap"
                                                >
                                                  <Box style={{ flex: 1 }}>
                                                    <Text fw={500}>
                                                      {it.name || "No name"}
                                                    </Text>
                                                    <Text size="xs" c="dimmed">
                                                      {it.set_name || "Unknown set"}
                                                    </Text>

                                                    <Group gap={6} mt={6}>
                                                      <Badge
                                                        size="sm"
                                                        color={
                                                          it.isFoil
                                                            ? "yellow"
                                                            : "gray"
                                                        }
                                                        variant={
                                                          it.isFoil
                                                            ? "filled"
                                                            : "light"
                                                        }
                                                      >
                                                        {it.isFoil
                                                          ? "Foil"
                                                          : "Non-Foil"}
                                                      </Badge>

                                                      {it.condition && (
                                                        <Badge
                                                          size="sm"
                                                          variant="light"
                                                          color="blue"
                                                        >
                                                          {it.condition}
                                                        </Badge>
                                                      )}
                                                    </Group>

                                                    <Text size="sm" mt={4}>
                                                      Qty: {it.quantity ?? "?"}
                                                    </Text>

                                                    <Group gap={6} mt={6}>
                                                      {(it.binLocations || []).map(
                                                        (b, i) => (
                                                          <Badge
                                                            key={i}
                                                            color="yellow"
                                                          >
                                                            {b.bin ?? "?"} / Row{
                                                              " "
                                                            }
                                                            {b.row ?? "?"} (x
                                                            {b.quantity ?? "?"})
                                                          </Badge>
                                                        )
                                                      )}
                                                    </Group>
                                                  </Box>

                                                  <Group
                                                    gap="xs"
                                                    justify="flex-end"
                                                    align="center"
                                                    style={{ flexShrink: 0 }}
                                                  >
                                                    <Button
                                                      size="xs"
                                                      variant={
                                                        isPicked
                                                          ? "filled"
                                                          : "outline"
                                                      }
                                                      color={
                                                        isPicked ? "green" : "gray"
                                                      }
                                                      loading={isBusy}
                                                      disabled={isBusy}
                                                      onClick={() =>
                                                        isPicked
                                                          ? persistUnpick(
                                                              o.id,
                                                              originalIndex,
                                                              it
                                                            )
                                                          : persistPick(
                                                              o.id,
                                                              originalIndex,
                                                              it
                                                            )
                                                      }
                                                    >
                                                      {isPicked
                                                        ? "Picked"
                                                        : "Mark picked"}
                                                    </Button>
                                                  </Group>
                                                </Group>

                                                <Group justify="flex-end" mt={4}>
                                                  <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="green"
                                                    onClick={() =>
                                                      handleMarkFulfilledUpTo(
                                                        o.id,
                                                        originalIndex
                                                      )
                                                    }
                                                  >
                                                    Mark up to here
                                                  </Button>
                                                </Group>
                                              </Box>
                                            </Group>
                                          );
                                        })}
                                      </Stack>
                                    );
                                  })()}
                              </Box>
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Fragment>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm" c="dimmed">
                  No paid CT Zero shipment orders in this shipment.
                </Text>
              )}
            </Paper>
          );
        })}
    </Stack>
  );
}
