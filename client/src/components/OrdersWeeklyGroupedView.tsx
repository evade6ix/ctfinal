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

type BinLocation = {
  bin: string;
  row: number;
  quantity: number;
};

type OrderItem = {
  id?: number | string;
  orderItemId?: number | null;
  hubPendingOrderId?: string | null;
  hubPendingOrderItemId?: number | null;
  cardTraderId?: number | null;
  blueprintId?: number | null;
  name?: string;
  quantity?: number;
  image_url?: string | null;
  set_name?: string | null;
  binLocations?: BinLocation[];
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  isFoil?: boolean;
  condition?: string | null;
};

type PickEntry = {
  key: string;
  item: OrderItem;
  itemIndex: number;
  location: BinLocation | null;
  locationIndex: number | null;
};

type FilterMode = "all" | "picked" | "unpicked";

function compareText(a: unknown, b: unknown) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function locationKey(location: BinLocation | null) {
  if (!location) return "__no_location__";
  return `${location.bin || "?"}::${location.row ?? "?"}`;
}

function buildPickEntries(items: OrderItem[]): PickEntry[] {
  const entries: PickEntry[] = [];

  items.forEach((item, itemIndex) => {
    const locations = (item.binLocations || []).filter(
      (location) => Number(location.quantity || 0) > 0
    );

    if (locations.length === 0) {
      entries.push({
        key: `${item.id ?? item.cardTraderId ?? itemIndex}-no-location-${itemIndex}`,
        item,
        itemIndex,
        location: null,
        locationIndex: null,
      });
      return;
    }

    locations.forEach((location, locationIndex) => {
      entries.push({
        key: `${item.id ?? item.cardTraderId ?? itemIndex}-${location.bin}-${location.row}-${locationIndex}`,
        item,
        itemIndex,
        location,
        locationIndex,
      });
    });
  });

  return entries.sort((a, b) => {
    if (a.location && !b.location) return -1;
    if (!a.location && b.location) return 1;

    if (a.location && b.location) {
      const binCompare = compareText(a.location.bin, b.location.bin);
      if (binCompare !== 0) return binCompare;

      const rowCompare = Number(a.location.row) - Number(b.location.row);
      if (rowCompare !== 0) return rowCompare;
    }

    const setCompare = compareText(a.item.set_name, b.item.set_name);
    if (setCompare !== 0) return setCompare;

    const nameCompare = compareText(a.item.name, b.item.name);
    if (nameCompare !== 0) return nameCompare;

    return a.itemIndex - b.itemIndex;
  });
}

function filterEntries(entries: PickEntry[], mode: FilterMode): PickEntry[] {
  if (mode === "picked") return entries.filter((entry) => !!entry.item.picked);
  if (mode === "unpicked") return entries.filter((entry) => !entry.item.picked);
  return entries;
}

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

  const getCardImageSrc = (item: OrderItem) => {
    if (
      item.image_url &&
      typeof item.image_url === "string" &&
      item.image_url.startsWith("http")
    ) {
      return item.image_url;
    }

    return "/card-placeholder.png";
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
      setItemsByOrder((prev) => ({
        ...prev,
        [orderId]: Array.isArray(loadedItems) ? loadedItems : [],
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
    itemIndex: number,
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
        const original = clone[itemIndex];
        if (!original) return prev;

        clone[itemIndex] = {
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

  function getPickKey(displayOrderId: string | number, itemIndex: number) {
    const item = itemsByOrder[displayOrderId]?.[itemIndex];
    return `${displayOrderId}-${item?.cardTraderId ?? item?.id ?? `idx-${itemIndex}`}`;
  }

  async function persistPick(
    displayOrderId: string | number,
    itemIndex: number,
    item: OrderItem
  ) {
    const key = getPickKey(displayOrderId, itemIndex);
    setPickingKey(key);

    try {
      const allocationOrderId = item.hubPendingOrderId || displayOrderId;
      const allocationOrderItemId =
        item.hubPendingOrderItemId ?? item.orderItemId ?? item.id;

      if (item.cardTraderId) {
        const res = await fetch("/api/order-allocations/pick", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: allocationOrderId,
            orderItemId: allocationOrderItemId,
            cardTraderId: item.cardTraderId,
            source: "cardtrader",
            pickedBy: window.localStorage.getItem("ctfinal_staff_name") || "local",
          }),
        });

        if (!res.ok) {
          console.error("Failed picking", await res.text());
          return;
        }
      }

      setItemsByOrder((prev) => {
        const arr = prev[displayOrderId];
        if (!arr) return prev;

        const clone = [...arr];
        if (!clone[itemIndex]) return prev;

        clone[itemIndex] = {
          ...clone[itemIndex],
          picked: true,
          pickedAt: new Date().toISOString(),
        };

        return { ...prev, [displayOrderId]: clone };
      });
    } finally {
      setPickingKey(null);
    }
  }

  async function persistUnpick(
    displayOrderId: string | number,
    itemIndex: number,
    item: OrderItem
  ) {
    const key = getPickKey(displayOrderId, itemIndex);
    setPickingKey(key);

    try {
      const allocationOrderId = item.hubPendingOrderId || displayOrderId;
      const allocationOrderItemId =
        item.hubPendingOrderItemId ?? item.orderItemId ?? item.id;

      if (item.cardTraderId) {
        const res = await fetch("/api/order-allocations/unpick", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: allocationOrderId,
            orderItemId: allocationOrderItemId,
            cardTraderId: item.cardTraderId,
            source: "cardtrader",
          }),
        });

        if (!res.ok) {
          console.error("Failed unpicking", await res.text());
          return;
        }
      }

      setItemsByOrder((prev) => {
        const arr = prev[displayOrderId];
        if (!arr) return prev;

        const clone = [...arr];
        if (!clone[itemIndex]) return prev;

        clone[itemIndex] = {
          ...clone[itemIndex],
          picked: false,
          pickedAt: null,
        };

        return { ...prev, [displayOrderId]: clone };
      });
    } finally {
      setPickingKey(null);
    }
  }

  async function handleMarkFulfilledUpTo(
    orderId: string | number,
    entryIndex: number,
    entries: PickEntry[]
  ) {
    const lastEntryIndexByItem = new Map<number, number>();
    entries.forEach((entry, index) => {
      lastEntryIndexByItem.set(entry.itemIndex, index);
    });

    const itemIndexesToPick = [
      ...new Set(
        entries
          .slice(0, entryIndex + 1)
          .filter(
            (entry) =>
              lastEntryIndexByItem.get(entry.itemIndex) !== undefined &&
              lastEntryIndexByItem.get(entry.itemIndex)! <= entryIndex
          )
          .map((entry) => entry.itemIndex)
      ),
    ];

    for (const itemIndex of itemIndexesToPick) {
      const item = itemsByOrder[orderId]?.[itemIndex];
      if (item && !item.picked) {
        // eslint-disable-next-line no-await-in-loop
        await persistPick(orderId, itemIndex, item);
      }
    }
  }

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. The live consolidated CT Zero shipment appears
        once CardTrader creates the paid shipment order. Each physical bin and row
        is shown as its own pick entry so the list follows your warehouse route.
        Images load on demand. Picked lines are stored in Mongo and shared with your
        other views.
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
          const shipmentOrders = (week.orders || []).filter((order) => {
            const state = String(order.state || "").toLowerCase();
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
                    {shipmentOrders.map((order) => (
                      <Fragment key={order.id}>
                        <Table.Tr
                          style={{ cursor: "pointer" }}
                          onClick={() => handleToggleOrder(order)}
                        >
                          <Table.Td>{order.code || order.id}</Table.Td>
                          <Table.Td>
                            <Badge color="green" variant="filled" size="xs">
                              {String(order.state || "").toUpperCase()}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            {order.createdAt
                              ? new Date(order.createdAt).toLocaleString("en-CA", {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })
                              : "-"}
                          </Table.Td>
                          <Table.Td>{order.formattedTotal ?? "-"}</Table.Td>
                          <Table.Td>
                            <Button
                              size="xs"
                              variant="light"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleToggleOrder(order);
                              }}
                            >
                              {expandedOrderId === order.id
                                ? "Hide cards"
                                : "View cards"}
                            </Button>
                          </Table.Td>
                        </Table.Tr>

                        {expandedOrderId === order.id && (
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
                                {!itemsByOrder[order.id] && loadingItems && (
                                  <Group justify="center" p="lg">
                                    <Loader size="sm" />
                                  </Group>
                                )}

                                {itemsByOrder[order.id] &&
                                  itemsByOrder[order.id].length === 0 &&
                                  !loadingItems && (
                                    <Text c="dimmed" ta="center">
                                      No line items found.
                                    </Text>
                                  )}

                                {itemsByOrder[order.id] &&
                                  itemsByOrder[order.id].length > 0 &&
                                  (() => {
                                    const allItems = itemsByOrder[order.id]!;
                                    const allEntries = buildPickEntries(allItems);
                                    const visibleEntries = filterEntries(
                                      allEntries,
                                      filterMode
                                    );
                                    const lastEntryIndexByItem = new Map<
                                      number,
                                      number
                                    >();

                                    allEntries.forEach((entry, index) => {
                                      lastEntryIndexByItem.set(
                                        entry.itemIndex,
                                        index
                                      );
                                    });

                                    if (
                                      visibleEntries.length === 0 &&
                                      !loadingItems
                                    ) {
                                      return (
                                        <Text c="dimmed" ta="center">
                                          No line items match the current filter.
                                        </Text>
                                      );
                                    }

                                    let previousGroupKey: string | null = null;

                                    return (
                                      <Stack gap="xs">
                                        {visibleEntries.map((entry) => {
                                          const item = entry.item;
                                          const isPicked = !!item.picked;
                                          const itemLocationCount =
                                            item.binLocations?.length || 0;
                                          const entryIndex = allEntries.indexOf(entry);
                                          const isLastLocationForItem =
                                            lastEntryIndexByItem.get(
                                              entry.itemIndex
                                            ) === entryIndex;
                                          const busyKey = getPickKey(
                                            order.id,
                                            entry.itemIndex
                                          );
                                          const isBusy = pickingKey === busyKey;
                                          const currentGroupKey = locationKey(
                                            entry.location
                                          );
                                          const showGroupHeader =
                                            currentGroupKey !== previousGroupKey;

                                          previousGroupKey = currentGroupKey;

                                          return (
                                            <Fragment key={entry.key}>
                                              {showGroupHeader && (
                                                <Group
                                                  justify="space-between"
                                                  mt="sm"
                                                  px="sm"
                                                  py={6}
                                                  style={{
                                                    background:
                                                      "var(--mantine-color-dark-6)",
                                                    borderRadius: 6,
                                                    border: "1px solid #3a3a3a",
                                                  }}
                                                >
                                                  <Text fw={700} size="sm">
                                                    {entry.location
                                                      ? `${entry.location.bin || "?"} / Row ${entry.location.row ?? "?"}`
                                                      : "No saved bin / row"}
                                                  </Text>
                                                </Group>
                                              )}

                                              <Group
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
                                                    src={getCardImageSrc(item)}
                                                    width={140}
                                                    height={196}
                                                    style={{
                                                      objectFit: "cover",
                                                      borderRadius: 6,
                                                    }}
                                                    loading="lazy"
                                                    decoding="async"
                                                    onError={(event) => {
                                                      (
                                                        event.target as HTMLImageElement
                                                      ).src =
                                                        "/card-placeholder.png";
                                                    }}
                                                    alt={item.name || "Card image"}
                                                  />
                                                  <Button
                                                    mt={6}
                                                    size="xs"
                                                    variant="subtle"
                                                    onClick={() =>
                                                      handleShowImage(
                                                        order.id,
                                                        entry.itemIndex,
                                                        item
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
                                                        {item.name || "No name"}
                                                      </Text>
                                                      <Text size="xs" c="dimmed">
                                                        {item.set_name ||
                                                          "Unknown set"}
                                                      </Text>

                                                      <Group gap={6} mt={6}>
                                                        <Badge
                                                          size="sm"
                                                          color={
                                                            item.isFoil
                                                              ? "yellow"
                                                              : "gray"
                                                          }
                                                          variant={
                                                            item.isFoil
                                                              ? "filled"
                                                              : "light"
                                                          }
                                                        >
                                                          {item.isFoil
                                                            ? "Foil"
                                                            : "Non-Foil"}
                                                        </Badge>

                                                        {item.condition && (
                                                          <Badge
                                                            size="sm"
                                                            variant="light"
                                                            color="blue"
                                                          >
                                                            {item.condition}
                                                          </Badge>
                                                        )}
                                                      </Group>

                                                      <Text size="sm" mt={4}>
                                                        Qty: {entry.location
                                                          ? entry.location.quantity
                                                          : item.quantity ?? "?"}
                                                      </Text>

                                                      <Group gap={6} mt={6}>
                                                        <Badge color="yellow">
                                                          {entry.location
                                                            ? `${entry.location.bin || "?"} / Row ${entry.location.row ?? "?"} (x${entry.location.quantity ?? "?"})`
                                                            : "No saved location"}
                                                        </Badge>
                                                      </Group>

                                                      {itemLocationCount > 1 &&
                                                        !isLastLocationForItem && (
                                                          <Text
                                                            size="xs"
                                                            c="dimmed"
                                                            mt={6}
                                                          >
                                                            This card has more
                                                            locations later in the
                                                            pick route.
                                                          </Text>
                                                        )}
                                                    </Box>

                                                    <Group
                                                      gap="xs"
                                                      justify="flex-end"
                                                      align="center"
                                                      style={{ flexShrink: 0 }}
                                                    >
                                                      {isLastLocationForItem && (
                                                        <Button
                                                          size="xs"
                                                          variant={
                                                            isPicked
                                                              ? "filled"
                                                              : "outline"
                                                          }
                                                          color={
                                                            isPicked
                                                              ? "green"
                                                              : "gray"
                                                          }
                                                          loading={isBusy}
                                                          disabled={isBusy}
                                                          onClick={() =>
                                                            isPicked
                                                              ? persistUnpick(
                                                                  order.id,
                                                                  entry.itemIndex,
                                                                  item
                                                                )
                                                              : persistPick(
                                                                  order.id,
                                                                  entry.itemIndex,
                                                                  item
                                                                )
                                                          }
                                                        >
                                                          {isPicked
                                                            ? "Picked"
                                                            : itemLocationCount > 1
                                                              ? "Mark all locations picked"
                                                              : "Mark picked"}
                                                        </Button>
                                                      )}
                                                    </Group>
                                                  </Group>

                                                  {isLastLocationForItem && (
                                                    <Group
                                                      justify="flex-end"
                                                      mt={4}
                                                    >
                                                      <Button
                                                        size="xs"
                                                        variant="subtle"
                                                        color="green"
                                                        onClick={() =>
                                                          handleMarkFulfilledUpTo(
                                                            order.id,
                                                            entryIndex,
                                                            allEntries
                                                          )
                                                        }
                                                      >
                                                        Mark up to here
                                                      </Button>
                                                    </Group>
                                                  )}
                                                </Box>
                                              </Group>
                                            </Fragment>
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
