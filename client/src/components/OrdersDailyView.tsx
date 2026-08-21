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
  TextInput,
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
  viaCardTraderZero?: boolean;
  via_cardtrader_zero?: boolean;
};

type OrderItem = {
  id?: number;
  orderItemId?: number;
  cardTraderId?: number;
  blueprintId?: number;
  name?: string;
  quantity?: number;
  set_name?: string;
  setCode?: string;
  binLocations?: { bin: string; row: number; quantity: number }[];
  image_url?: string;

  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;

  isFoil?: boolean;
  condition?: string | null;
};

type DailyAllocationRef = {
  orderId: string | number;
  orderItemId?: number;
  cardTraderId?: number;
  quantity?: number;
  picked?: boolean;
};

type DailyLine = {
  name: string;
  set_name?: string;
  setCode?: string;
  bin: string;
  row?: number;
  quantity: number;
  image_url?: string;

  isFoil?: boolean;
  condition?: string | null;

  allocations: DailyAllocationRef[];
  totalAllocations: number;
  pickedAllocations: number;

  groupKey: string;
};

const API_BASE = "/api";
const PER_PAGE = 50;

function sortDailyLines(lines: DailyLine[]): DailyLine[] {
  return [...lines].sort((a, b) => {
    const aBin = (a.bin || "").toString();
    const bBin = (b.bin || "").toString();

    if (aBin !== bBin) {
      return aBin.localeCompare(bBin, undefined, { numeric: true });
    }

    const aRow = a.row ?? Number.MAX_SAFE_INTEGER;
    const bRow = b.row ?? Number.MAX_SAFE_INTEGER;

    if (aRow !== bRow) {
      return aRow - bRow;
    }

    const aSet = (a.setCode || a.set_name || "").toString().toLowerCase();
    const bSet = (b.setCode || b.set_name || "").toString().toLowerCase();

    if (aSet !== bSet) {
      return aSet.localeCompare(bSet, undefined, { numeric: true });
    }

    const aName = (a.name || "").toString().toLowerCase();
    const bName = (b.name || "").toString().toLowerCase();

    return aName.localeCompare(bName, undefined, { numeric: true });
  });
}

function getOrderValueCents(order: OrderSummary): number {
  if (typeof order.sellerTotalCents === "number") {
    return order.sellerTotalCents;
  }

  if (order.formattedTotal) {
    const cleaned = order.formattedTotal.replace(/[^\d.,-]/g, "");
    const normalized = cleaned.replace(",", ".");
    const num = parseFloat(normalized);

    if (!Number.isNaN(num)) {
      return Math.round(num * 100);
    }
  }

  return 0;
}

export function OrdersDailyView() {
  const [activeOrders, setActiveOrders] = useState<OrderSummary[]>([]);
  const [lines, setLines] = useState<DailyLine[]>([]);

  const [loading, setLoading] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [cardSearch, setCardSearch] = useState("");

  const [imageOpenByKey, setImageOpenByKey] = useState<Record<string, boolean>>(
    {}
  );

  const [imageLoadingKey, setImageLoadingKey] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

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
        const allOrders = data || [];

       const zeroHubPendingOrders = allOrders.filter((o) => {
  const state = String(o.state || "").toUpperCase();

  const isZero =
    o.viaCardTraderZero === true || o.via_cardtrader_zero === true;

  return state === "HUB_PENDING" && isZero;
});

        setActiveOrders(zeroHubPendingOrders);
      } catch (err: any) {
        console.error("Failed to fetch orders:", err);
        setError(err?.message ?? "Failed to fetch orders");
      } finally {
        setLoading(false);
      }
    }

    fetchOrders();
  }, []);

  useEffect(() => {
    async function buildActivePickingLines() {
      if (!activeOrders.length) {
        setLines([]);
        return;
      }

      setLinesLoading(true);

      try {
        const lineMap: Record<string, DailyLine> = {};

        await Promise.all(
          activeOrders.map(async (order) => {
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

            for (const it of items) {
              const name = it.name || "Unknown card";
              const setCode = it.setCode;
              const setName = it.set_name || "";
              const setKey = (setCode || setName || "").toString();

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

                const foilKey = it.isFoil ? "foil" : "nonfoil";
                const conditionKey = it.condition || "";

                /*
                 * IMPORTANT:
                 * This key defines one visible picking row.
                 *
                 * It is NOT just card name.
                 * It is:
                 * bin + row + set + card name + foil + condition
                 *
                 * So "Mark row picked" only marks allocations inside this exact visible row.
                 */
                const key = `${binLabel}|${
                  rowVal ?? 0
                }|${setKey}|${name}|${foilKey}|${conditionKey}`;

                if (!lineMap[key]) {
                  lineMap[key] = {
                    name,
                    set_name: setName,
                    setCode,
                    bin: binLabel,
                    row: typeof rowVal === "number" ? rowVal : undefined,
                    quantity: 0,
                    image_url: it.image_url,
                    isFoil: it.isFoil,
                    condition: it.condition ?? null,
                    allocations: [],
                    totalAllocations: 0,
                    pickedAllocations: 0,
                    groupKey: key,
                  };
                }

                const line = lineMap[key];

                if (!line.image_url && it.image_url) {
                  line.image_url = it.image_url;
                }

                const qtyAdd = loc.quantity ?? it.quantity ?? 0;
                line.quantity = (line.quantity || 0) + qtyAdd;

                const orderItemId = it.orderItemId ?? it.id;

                line.allocations.push({
  orderId: order.id,
  orderItemId,
  cardTraderId: it.cardTraderId,
  quantity: qtyAdd,
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

        setLines(sortDailyLines(Object.values(lineMap)));
        setPage(1);
      } finally {
        setLinesLoading(false);
      }
    }

    buildActivePickingLines();
  }, [activeOrders]);

  const toggleImageForKey = (key: string) => {
    setImageOpenByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleShowImageForLine = async (line: DailyLine) => {
    if (!line.name) return;

    const rowKey = line.groupKey;
    setImageLoadingKey(rowKey);

    try {
      const res = await fetch(
        `${API_BASE}/order-articles/image?name=${encodeURIComponent(line.name)}`
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

      setLines((prev) =>
        prev.map((l) =>
          l.groupKey === rowKey
            ? { ...l, image_url: json.image_url || l.image_url }
            : l
        )
      );
    } catch (err) {
      console.error("Error in handleShowImageForLine:", err);
    } finally {
      setImageLoadingKey(null);
    }
  };

  /*
   * Pick/unpick for ONE VISIBLE ROW.
   *
   * This does not pick by card name globally.
   * It only loops through the allocations attached to this exact row key:
   * bin + row + set + card + foil + condition.
   *
   * Backend saves picked status on OrderAllocation.
   * Zero Weekly Shipments can later read the same OrderAllocation.
   */
  const handleTogglePickedLine = async (line: DailyLine) => {
    const validAllocs = line.allocations.filter(
      (a) => typeof a.cardTraderId === "number" && a.orderItemId != null
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
              orderItemId: alloc.orderItemId,
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

      setLines((prev) =>
        prev.map((l) => {
          if (l.groupKey !== line.groupKey) return l;

          const newPickedCount = allPicked ? 0 : l.totalAllocations;

          return {
            ...l,
            pickedAllocations: newPickedCount,
            allocations: l.allocations.map((a) => ({
              ...a,
              picked: !allPicked,
            })),
          };
        })
      );
    } finally {
      setTogglingKey(null);
    }
  };

  const searchTerm = cardSearch.trim().toLowerCase();

  const filteredLines = searchTerm
    ? lines.filter((line) => {
        const haystack = [
          line.name,
          line.set_name,
          line.setCode,
          line.bin,
          line.condition,
          line.isFoil ? "foil" : "non-foil",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(searchTerm);
      })
    : lines;

  const totalPages = Math.max(1, Math.ceil(filteredLines.length / PER_PAGE));
  const safePage = page > totalPages ? 1 : page;
  const startIndex = (safePage - 1) * PER_PAGE;
  const pageLines = filteredLines.slice(startIndex, startIndex + PER_PAGE);

  const activeOrderCount = activeOrders.length;
  const activeTotalCents = activeOrders.reduce(
    (sum, order) => sum + getOrderValueCents(order),
    0
  );

  const totalQty = lines.reduce((sum, line) => sum + (line.quantity || 0), 0);
  const pickedRows = lines.filter(
    (line) =>
      line.totalAllocations > 0 &&
      line.pickedAllocations === line.totalAllocations
  ).length;

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Daily Sales / Zero Pick List</Title>
          <Text c="dimmed" size="sm">
            One active picking screen for all current CardTrader{" "}
            <strong>HUB_PENDING</strong> Zero orders. Sorted by bin and row.
            Picked status is saved on the original allocation and can carry into
            Zero Weekly Shipments.
          </Text>
        </div>

        <Group gap="xs">
          <Badge variant="light">Active orders: {activeOrderCount}</Badge>
          <Badge variant="light">Lines: {lines.length}</Badge>
          <Badge variant="light">Qty: {totalQty}</Badge>
          <Badge variant="light">
            Picked rows: {pickedRows} / {lines.length}
          </Badge>
          <Badge variant="light">
            Total: C${(activeTotalCents / 100).toFixed(2)}
          </Badge>
        </Group>
      </Group>

      <TextInput
        mb="md"
        placeholder="Search all active Zero orders by card, set, bin, condition, foil..."
        value={cardSearch}
        onChange={(event) => {
          setCardSearch(event.currentTarget.value);
          setPage(1);
        }}
      />

      {loading && (
        <Group justify="center" mt="lg">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Loading active Zero orders…
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

      {!loading && !error && activeOrders.length === 0 && (
        <Text c="dimmed" mt="md">
          No active <strong>HUB_PENDING</strong> Zero orders found.
        </Text>
      )}

      {linesLoading && (
        <Group justify="center" mt="sm">
          <Loader size="xs" />
          <Text c="dimmed" size="xs">
            Building active pick list…
          </Text>
        </Group>
      )}

      {!loading && !error && activeOrders.length > 0 && (
        <Card withBorder radius="lg">
          <Group justify="space-between" mb="xs">
            <Text size="sm" c="dimmed">
              Showing {filteredLines.length === 0 ? 0 : startIndex + 1}–
              {Math.min(startIndex + PER_PAGE, filteredLines.length)} of{" "}
              {filteredLines.length} visible rows
            </Text>

            {totalPages > 1 && (
              <Pagination
                size="sm"
                value={safePage}
                total={totalPages}
                onChange={setPage}
              />
            )}
          </Group>

          <ScrollArea>
            <Table striped highlightOnHover withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Bin</Table.Th>
                  <Table.Th>Row</Table.Th>
                  <Table.Th>Set</Table.Th>
                  <Table.Th>Card</Table.Th>
                  <Table.Th>Foil</Table.Th>
                  <Table.Th>Condition</Table.Th>
                  <Table.Th>Qty</Table.Th>
                  <Table.Th>Picked</Table.Th>
                  <Table.Th>Image</Table.Th>
                </Table.Tr>
              </Table.Thead>

              <Table.Tbody>
                {filteredLines.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={9}>
                      <Text c="dimmed" size="sm">
                        No matching line items found.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}

                {pageLines.map((line) => {
  const rowKey = line.groupKey;
  const isOpen = !!imageOpenByKey[rowKey];

  const allPicked =
    line.totalAllocations > 0 &&
    line.pickedAllocations === line.totalAllocations;

  const pickedQty = line.allocations.reduce(
    (sum, alloc) => sum + (alloc.picked ? alloc.quantity || 0 : 0),
    0
  );

  return (
                    <Table.Tr key={rowKey}>
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
                        <Badge
                          size="sm"
                          color={line.isFoil ? "yellow" : "gray"}
                          variant={line.isFoil ? "filled" : "light"}
                        >
                          {line.isFoil ? "Foil" : "Non-Foil"}
                        </Badge>
                      </Table.Td>

                      <Table.Td>
                        <Text>{line.condition || "-"}</Text>
                      </Table.Td>

                      <Table.Td>
                        <Text>{line.quantity}</Text>
                      </Table.Td>

                      <Table.Td>
                        <Stack gap={4}>
                          <Text size="xs" c="dimmed">
  Qty picked {pickedQty} / {line.quantity}
</Text>
<Text size="xs" c="dimmed">
  Order lines {line.pickedAllocations} / {line.totalAllocations}
</Text>

                          <Button
                            size="xs"
                            variant={allPicked ? "outline" : "filled"}
                            color={allPicked ? "red" : "green"}
                            loading={togglingKey === rowKey}
                            onClick={() => handleTogglePickedLine(line)}
                          >
                            {allPicked ? "Unpick row" : "Mark row picked"}
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
                                src={line.image_url || "/card-placeholder.png"}
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
                onChange={setPage}
              />
            </Group>
          )}
        </Card>
      )}
    </Box>
  );
}