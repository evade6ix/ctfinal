import { useEffect, useState, Fragment, type ChangeEvent } from "react";
import * as XLSX from "xlsx";
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
  cardTraderId?: number;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  image_url?: string; // Scryfall URL from /api/order-articles or /image
  set_name?: string;
  binLocations?: { bin: string; row: number; quantity: number }[];
};

// Shape we pull from the CardTrader XLS picklist
type XlsRow = {
  setName?: string;
  setCode?: string;
  itemName?: string;
  quantity?: number;
  condition?: string;
  language?: string;
  collectorNumber?: string | number;
};

const normalize = (s?: string | null) =>
  s ? s.toString().trim().replace(/\s+/g, " ").toLowerCase() : "";

// Try to match an order line to a row in the XLS by name + set (+ qty)
const matchXlsRow = (item: OrderItem, rows: XlsRow[]): XlsRow | null => {
  const nName = normalize(item.name);
  const nSet = normalize(item.set_name);

  if (!nName) return null;

  let candidates = rows.filter((r) => normalize(r.itemName) === nName);

  if (nSet) {
    const bySet = candidates.filter((r) => normalize(r.setName) === nSet);
    if (bySet.length > 0) {
      candidates = bySet;
    }
  }

  if (candidates.length > 1 && typeof item.quantity === "number") {
    const byQty = candidates.filter((r) => r.quantity === item.quantity);
    if (byQty.length > 0) {
      candidates = byQty;
    }
  }

  return candidates[0] || null;
};

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklySummary[]>([]);
  const [loading, setLoading] = useState(false);

  const [expandedOrderId, setExpandedOrderId] = useState<
    string | number | null
  >(null);

  const [itemsByOrder, setItemsByOrder] = useState<
    Record<string | number, OrderItem[]>
  >({});

  const [loadingItems, setLoadingItems] = useState(false);

  // ✅ In-memory "picked" state: per orderId → per index
  const [pickedByOrder, setPickedByOrder] = useState<
    Record<string | number, Record<number, boolean>>
  >({});

  // ✅ XLS rows per order (in-memory only)
  const [xlsByOrder, setXlsByOrder] = useState<
    Record<string | number, XlsRow[]>
  >({});

  const [xlsErrorByOrder, setXlsErrorByOrder] = useState<
    Record<string | number, string | null>
  >({});

  // ───────────────────────────────────────────────
  // Initial weekly summaries
  // ───────────────────────────────────────────────
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

  // Sort items: bins first (by bin → row), then no-bin by set_name → name
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

  // ⭐ Scryfall-only image selection: image_url → placeholder
  const getCardImageSrc = (it: OrderItem) => {
    if (
      it.image_url &&
      typeof it.image_url === "string" &&
      it.image_url.startsWith("http")
    ) {
      return it.image_url;
    }

    // FINAL fallback – local placeholder
    return "/card-placeholder.png";
  };

  // Load items for a single order from /api/order-articles/:id
  // Now uses skipImages=1 to avoid Scryfall on initial load (faster)
  const loadItems = async (orderId: string | number) => {
    if (itemsByOrder[orderId]) return; // already cached

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

      const data = (await res.json()) as OrderItem[];
      const sorted = sortOrderItems(data);

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

  const handleToggleOrder = (orderId: string | number) => {
    const willExpand = expandedOrderId !== orderId;
    setExpandedOrderId(willExpand ? orderId : null);

    if (willExpand) {
      loadItems(orderId);
    }
  };

  // On-demand: fetch real image for a single card by name
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
      if (!json.image_url) {
        console.warn("No image_url returned for", name);
        return;
      }

      // Update just that one item in state
      setItemsByOrder((prev) => {
        const existing = prev[orderId];
        if (!existing) return prev;

        const clone = [...existing];
        const original = clone[index];
        if (!original) return prev;

        clone[index] = {
          ...original,
          image_url: json.image_url || original.image_url,
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

  // Toggle picked state for a specific line item
  const handleTogglePicked = (orderId: string | number, index: number) => {
    setPickedByOrder((prev) => {
      const forOrder = prev[orderId] || {};
      const currentlyPicked = !!forOrder[index];

      const updatedForOrder: Record<number, boolean> = {
        ...forOrder,
        [index]: !currentlyPicked,
      };

      return {
        ...prev,
        [orderId]: updatedForOrder,
      };
    });
  };

  // Mark all items up to (and including) this index as picked
  const handleMarkFulfilledUpTo = (
    orderId: string | number,
    index: number
  ) => {
    setPickedByOrder((prev) => {
      const existingForOrder = prev[orderId] || {};
      const updatedForOrder: Record<number, boolean> = {
        ...existingForOrder,
      };

      for (let i = 0; i <= index; i++) {
        updatedForOrder[i] = true;
      }

      return {
        ...prev,
        [orderId]: updatedForOrder,
      };
    });
  };

  // Handle Excel upload for a specific order (front-end only)
  const handleXlsUpload = async (
    orderId: string | number,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

      const rows: XlsRow[] = json.map((row) => ({
        setName: row["Set Name"] ?? row["set_name"],
        setCode: row["Set Code"] ?? row["set_code"],
        itemName: row["Item Name"] ?? row["item_name"],
        quantity:
          typeof row["Quantity"] === "number"
            ? row["Quantity"]
            : row["Quantity"] != null
            ? Number(row["Quantity"]) || undefined
            : undefined,
        condition: row["Condition"] ?? row["condition"],
        language: row["Language"] ?? row["language"],
        collectorNumber:
          row["Collector Number"] ?? row["collector_number"] ?? undefined,
      }));

      setXlsByOrder((prev) => ({
        ...prev,
        [orderId]: rows,
      }));
      setXlsErrorByOrder((prev) => ({
        ...prev,
        [orderId]: null,
      }));
    } catch (err) {
      console.error("Error parsing XLS for order", orderId, err);
      setXlsErrorByOrder((prev) => ({
        ...prev,
        [orderId]:
          "Failed to read Excel file. Make sure it's the CardTrader picklist export.",
      }));
    } finally {
      // reset input so you can upload the same file again if needed
      event.target.value = "";
    }
  };

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. All PAID orders combined. Click an order to
        see its cards sorted by bin and row. Images load on demand. You can
        attach the CardTrader Excel picklist for extra data.
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

              {/* PAID ORDERS FOR THIS WEEK */}
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
                    {paidOrders.map((o) => {
                      const xlsRows = xlsByOrder[o.id] || [];
                      const xlsError = xlsErrorByOrder[o.id] || null;

                      return (
                        <Fragment key={o.id}>
                          {/* MAIN ORDER ROW */}
                          <Table.Tr
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
                                ? new Date(o.createdAt).toLocaleString(
                                    "en-CA",
                                    {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    }
                                  )
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
                                  {/* XLS UPLOAD BAR FOR THIS ORDER */}
                                  <Group
                                    mb="sm"
                                    justify="space-between"
                                    align="center"
                                  >
                                    <Stack gap={2}>
                                      <Text size="sm" fw={500}>
                                        Excel picklist (optional)
                                      </Text>
                                      <Text size="xs" c="dimmed">
                                        Attach the CardTrader XLS/XLSX export
                                        for this order to see set code, collector
                                        number, etc. (UI only – no inventory
                                        changes).
                                      </Text>
                                    </Stack>

                                    <Stack gap={4} align="flex-end">
                                      <input
                                        type="file"
                                        accept=".xls,.xlsx"
                                        onChange={(e) =>
                                          handleXlsUpload(o.id, e)
                                        }
                                        style={{ maxWidth: 220 }}
                                      />
                                      <Text size="xs" c="dimmed">
                                        {xlsRows.length > 0
                                          ? `Loaded ${xlsRows.length} rows`
                                          : "No XLS attached"}
                                      </Text>
                                      {xlsError && (
                                        <Text size="xs" c="red">
                                          {xlsError}
                                        </Text>
                                      )}
                                    </Stack>
                                  </Group>

                                  {/* Loading state for this order */}
                                  {!itemsByOrder[o.id] && loadingItems && (
                                    <Group justify="center" p="lg">
                                      <Loader size="sm" />
                                    </Group>
                                  )}

                                  {/* No line items */}
                                  {itemsByOrder[o.id] &&
                                    itemsByOrder[o.id].length === 0 &&
                                    !loadingItems && (
                                      <Text c="dimmed" ta="center">
                                        No line items found.
                                      </Text>
                                    )}

                                  {/* Line items – all at once, images on demand */}
                                  {itemsByOrder[o.id] &&
                                    itemsByOrder[o.id].length > 0 && (
                                      <Stack gap="md">
                                        {itemsByOrder[o.id].map(
                                          (it, idx) => {
                                            const isPicked =
                                              !!pickedByOrder[o.id]?.[idx];
                                            const xlsMatch = matchXlsRow(
                                              it,
                                              xlsRows
                                            );

                                            return (
                                              <Group
                                                key={idx}
                                                align="flex-start"
                                                wrap="nowrap"
                                                style={{
                                                  padding: "8px 12px",
                                                  borderBottom:
                                                    "1px solid #333",
                                                  background: isPicked
                                                    ? "rgba(46, 204, 113, 0.12)" // soft green
                                                    : "transparent",
                                                  borderLeft: isPicked
                                                    ? "3px solid #2ecc71"
                                                    : "3px solid transparent",
                                                  borderRadius: 4,
                                                }}
                                              >
                                                {/* IMAGE + BUTTON */}
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
                                                      ).src =
                                                        "/card-placeholder.png";
                                                    }}
                                                    alt={
                                                      it.name || "Card image"
                                                    }
                                                  />
                                                  <Button
                                                    mt={6}
                                                    size="xs"
                                                    variant="subtle"
                                                    onClick={() =>
                                                      handleShowImage(
                                                        o.id,
                                                        idx,
                                                        it
                                                      )
                                                    }
                                                  >
                                                    Show image
                                                  </Button>
                                                </Box>

                                                {/* DETAILS + PICKED BUTTONS */}
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
                                                      <Text
                                                        size="xs"
                                                        c="dimmed"
                                                      >
                                                        {it.set_name ||
                                                          "Unknown set"}
                                                      </Text>

                                                      {/* XLS match line */}
                                                      {xlsMatch && (
                                                        <Text
                                                          size="xs"
                                                          c="teal.2"
                                                          mt={2}
                                                        >
                                                          XLS:{" "}
                                                          {xlsMatch.setCode ||
                                                            xlsMatch.setName ||
                                                            "?"}
                                                          {xlsMatch.collectorNumber !=
                                                            null &&
                                                            ` · #${xlsMatch.collectorNumber}`}
                                                          {xlsMatch.condition &&
                                                            ` · ${xlsMatch.condition}`}
                                                          {xlsMatch.language &&
                                                            ` · ${xlsMatch.language}`}
                                                          {typeof xlsMatch.quantity ===
                                                            "number" &&
                                                            ` · Qty ${xlsMatch.quantity}`}
                                                        </Text>
                                                      )}

                                                      <Text size="sm" mt={4}>
                                                        Qty:{" "}
                                                        {it.quantity ?? "?"}
                                                      </Text>

                                                      {/* BIN LOCATIONS */}
                                                      <Group gap={6} mt={6}>
                                                        {(
                                                          it.binLocations || []
                                                        ).map((b, i) => (
                                                          <Badge
                                                            key={i}
                                                            color="yellow"
                                                          >
                                                            {b.bin ?? "?"} /
                                                            Row{" "}
                                                            {b.row ?? "?"} (x
                                                            {b.quantity ?? "?"}
                                                            )
                                                          </Badge>
                                                        ))}
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
                                                          isPicked
                                                            ? "green"
                                                            : "gray"
                                                        }
                                                        onClick={() =>
                                                          handleTogglePicked(
                                                            o.id,
                                                            idx
                                                          )
                                                        }
                                                      >
                                                        {isPicked
                                                          ? "Picked"
                                                          : "Mark picked"}
                                                      </Button>

                                                      <Button
                                                        size="xs"
                                                        variant="subtle"
                                                        color="green"
                                                        onClick={() =>
                                                          handleMarkFulfilledUpTo(
                                                            o.id,
                                                            idx
                                                          )
                                                        }
                                                      >
                                                        Mark up to here
                                                      </Button>
                                                    </Group>
                                                  </Group>
                                                </Box>
                                              </Group>
                                            );
                                          }
                                        )}
                                      </Stack>
                                    )}
                                </Box>
                              </Table.Td>
                            </Table.Tr>
                          )}
                        </Fragment>
                      );
                    })}
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
