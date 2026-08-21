import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Group,
  Title,
  Text,
  Paper,
  Loader,
  Select,
  NumberInput,
  Table,
  ScrollArea,
  Badge,
  Stack,
  Alert,
} from "@mantine/core";
import { IconAlertTriangle, IconBox } from "@tabler/icons-react";

type Bin = {
  _id: string;
  name?: string;
  label?: string;
};

type Location = {
  bin: string | { _id: string; name?: string; label?: string };
  row: number;
  quantity: number;
};

type InventoryItem = {
  _id: string;
  cardTraderId?: number; // 👈 add this
  name: string;
  setCode?: string;
  setName?: string;
  game?: string;
  condition?: string;
  isFoil?: boolean;
  price?: number;
  totalQuantity?: number;
  quantity?: number; // in case backend uses this instead of totalQuantity
  locations?: Location[];
};

type BulkAssignResponse = {
  ok?: boolean;
  updatedCount?: number;
  [key: string]: any;
};

export function InventoryBinAssignmentView() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);

  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingBins, setLoadingBins] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assigningUnassigned, setAssigningUnassigned] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  const [row, setRow] = useState<number | "" | undefined>(1);

  // ---------- Fetch inventory items ----------
  useEffect(() => {
    async function fetchInventory() {
      try {
        setLoadingItems(true);
        setError(null);

        const res = await fetch("/api/inventory");
        const contentType = res.headers.get("content-type") || "";

        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            text || `Failed to load inventory (status ${res.status})`
          );
        }

        if (!contentType.includes("application/json")) {
          const text = await res.text();
          throw new Error(
            `Expected JSON from /api/inventory but got: ${text.slice(0, 200)}`
          );
        }

        const data = await res.json();
        const arr: InventoryItem[] = Array.isArray(data)
          ? data
          : Array.isArray(data.items)
          ? data.items
          : [];

        setItems(arr);
      } catch (err: any) {
        console.error("Error loading inventory:", err);
        setError(err.message || "Failed to load inventory items");
      } finally {
        setLoadingItems(false);
      }
    }

    fetchInventory();
  }, []);

  // ---------- Fetch bins ----------
  useEffect(() => {
    async function fetchBins() {
      try {
        setLoadingBins(true);
        setError(null);

        const res = await fetch("/api/bins");
        const contentType = res.headers.get("content-type") || "";

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Failed to load bins (status ${res.status})`);
        }

        if (!contentType.includes("application/json")) {
          const text = await res.text();
          throw new Error(
            `Expected JSON from /api/bins but got: ${text.slice(0, 200)}`
          );
        }

        const data = await res.json();
        const arr: Bin[] = Array.isArray(data)
          ? data
          : Array.isArray(data.bins)
          ? data.bins
          : [];

        setBins(arr);
      } catch (err: any) {
        console.error("Error loading bins:", err);
        setError(err.message || "Failed to load bins");
      } finally {
        setLoadingBins(false);
      }
    }

    fetchBins();
  }, []);

  // ---------- Derived: Set options ----------
  const setOptions = useMemo(() => {
    const map = new Map<string, string>();

    for (const item of items) {
      const code = (item.setCode || "").trim();
      const name = (item.setName || "").trim();

      if (!code && !name) continue;

      const key = code || name;
      const label = code && name ? `${code} – ${name}` : code || name;
      if (!map.has(key)) {
        map.set(key, label);
      }
    }

    return Array.from(map.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [items]);

  // ---------- Derived: Bin options ----------
  const binOptions = useMemo(
    () =>
      bins.map((b) => ({
        value: String(b._id),
        label: b.label || b.name || `Bin ${b._id}`,
      })),
    [bins]
  );

  // ---------- Filtered items by selected set ----------
  const filteredItems = useMemo(() => {
    if (!selectedSet) return [];
    return items.filter((it) => {
      const code = (it.setCode || "").trim();
      const name = (it.setName || "").trim();
      return code === selectedSet || name === selectedSet;
    });
  }, [items, selectedSet]);

  // ---------- Helpers to compute assigned/unassigned ----------
  function getTotalQuantity(item: InventoryItem): number {
    if (typeof item.totalQuantity === "number") return item.totalQuantity;
    if (typeof item.quantity === "number") return item.quantity;
    return 0;
  }

  function getAssignedQuantity(item: InventoryItem): number {
    if (!Array.isArray(item.locations)) return 0;
    return item.locations.reduce(
      (sum, loc) => sum + (loc.quantity || 0),
      0
    );
  }

  async function handleBulkAssign() {
    if (!selectedSet) {
      setError("Select a set to assign.");
      return;
    }
    if (!selectedBinId) {
      setError("Select a bin to assign to.");
      return;
    }
    // 🔁 UPDATED: allow rows 1–100
    if (typeof row !== "number" || row < 1 || row > 100) {
      setError("Row must be between 1 and 100.");
      return;
    }

    setError(null);
    setSuccessMessage(null);

    // Build items payload from the currently filtered items in this set
    const itemsPayload = filteredItems
      .map((item) => {
        const total = getTotalQuantity(item);
        const assigned = getAssignedQuantity(item);
        const unassigned = Math.max(0, total - assigned);

        // Only assign unassigned quantity, and only if we know the CT listing id
        if (!item.cardTraderId || unassigned <= 0) {
          return null;
        }

        return {
          cardTraderId: item.cardTraderId,
          name: item.name,
          game: item.game,
          setCode: item.setCode,
          condition: item.condition,
          isFoil: item.isFoil,
          price: item.price,
          quantity: unassigned,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (itemsPayload.length === 0) {
      setError(
        "No unassigned quantity found for this set (or missing CardTrader IDs)."
      );
      return;
    }

    try {
      setAssigning(true);

      const body = {
        binId: selectedBinId,
        row,
        mode: "assignExisting", // 👈 we'll use this on the backend
        items: itemsPayload,
      };

      const res = await fetch("/api/inventory/bulk-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const contentType = res.headers.get("content-type") || "";
      let data: BulkAssignResponse | any = {};

      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        data = { raw: text };
      }

      if (!res.ok || data.error || data.ok === false) {
        console.error("Bulk assign failed:", data);
        throw new Error(
          data.error ||
            data.message ||
            `Bulk assign failed with status ${res.status}`
        );
      }

      const updatedCount =
        typeof data.updated === "number"
          ? data.updated
          : typeof data.updatedCount === "number"
          ? data.updatedCount
          : undefined;

      setSuccessMessage(
        updatedCount != null
          ? `Assigned bin to ${updatedCount} items from this set.`
          : "Bulk assignment completed."
      );

      // Re-fetch inventory so UI shows updated locations/quantities
      const refresh = await fetch("/api/inventory");
      if (
        refresh.ok &&
        refresh.headers.get("content-type")?.includes("application/json")
      ) {
        const refreshJson = await refresh.json();
        const arr: InventoryItem[] = Array.isArray(refreshJson)
          ? refreshJson
          : Array.isArray(refreshJson.items)
          ? refreshJson.items
          : [];
        setItems(arr);
      }
    } catch (err: any) {
      console.error("Bulk assign error:", err);
      setError(err.message || "Bulk assignment failed");
    } finally {
      setAssigning(false);
    }
  }

  async function handleAssignUnassignedToBin() {
    if (!selectedSet) {
      setError("Select a set first.");
      return;
    }
    if (!selectedBinId) {
      setError("Select a bin.");
      return;
    }
    // 🔁 UPDATED: allow rows 1–100
    if (typeof row !== "number" || row < 1 || row > 100) {
      setError("Row must be 1–100.");
      return;
    }

    setError(null);
    setSuccessMessage(null);
    setAssigningUnassigned(true);

    try {
      const res = await fetch("/api/inventory/assign-unassigned-set-to-bin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setCode: selectedSet,
          binId: selectedBinId,
          row,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error || data.ok === false) {
        throw new Error(data.error || "Assignment failed");
      }

      setSuccessMessage(
        `Assigned ${data.totalMoved} unassigned cards from ${selectedSet} to bin.`
      );

      // Refresh inventory list
      const refresh = await fetch("/api/inventory");
      if (refresh.ok) {
        const json = await refresh.json();
        const arr: InventoryItem[] = Array.isArray(json)
          ? json
          : json.items || [];
        setItems(arr);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to assign unassigned items.");
    } finally {
      setAssigningUnassigned(false);
    }
  }

  // ---------- Render ----------
  const anyLoading = loadingItems || loadingBins;

  return (
    <Stack gap="md">
      <Box>
        <Title order={2}>Inventory</Title>
        <Text c="dimmed" size="sm" mt={4}>
          View your existing inventory and bulk-assign it into{" "}
          <strong>bins &amp; rows</strong>. A card can have{" "}
          <strong>multiple bin locations</strong>, so this is perfect for
          spreading a set across your physical layout.
        </Text>
      </Box>

      {error && (
        <Alert
          color="red"
          radius="md"
          icon={<IconAlertTriangle size={18} />}
          variant="light"
        >
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert
          color="teal"
          radius="md"
          icon={<IconBox size={18} />}
          variant="light"
        >
          {successMessage}
        </Alert>
      )}

      <Paper withBorder radius="md" p="md">
        <Group align="flex-end" justify="space-between" wrap="wrap" gap="md">
          <Group align="flex-end" gap="md" wrap="wrap">
            <Select
              label="Set"
              placeholder={
                anyLoading
                  ? "Loading inventory..."
                  : setOptions.length === 0
                  ? "No sets found"
                  : "Select a set"
              }
              data={setOptions}
              value={selectedSet}
              onChange={setSelectedSet}
              searchable
              nothingFoundMessage="No sets"
              w={260}
            />

            <Select
              label="Bin"
              placeholder={
                loadingBins ? "Loading bins..." : "Select a bin for this set"
              }
              data={binOptions}
              value={selectedBinId}
              onChange={setSelectedBinId}
              disabled={loadingBins || binOptions.length === 0}
              nothingFoundMessage="No bins"
              w={220}
            />

            <NumberInput
              label="Row"
              value={row}
              onChange={(value) => {
                const v =
                  typeof value === "number"
                    ? value
                    : typeof value === "string"
                    ? Number(value)
                    : 1;
                if (!Number.isFinite(v)) {
                  setRow(1);
                } else {
                  // 🔁 UPDATED: clamp between 1 and 100
                  setRow(Math.min(100, Math.max(1, Math.floor(v))));
                }
              }}
              min={1}
              max={100}
              clampBehavior="strict"
              w={120}
            />
          </Group>

          <Button
            variant="filled"
            radius="xl"
            size="md"
            leftSection={<IconBox size={18} />}
            disabled={
              !selectedSet || !selectedBinId || anyLoading || assigning
            }
            loading={assigning}
            onClick={handleBulkAssign}
          >
            Assign entire set to bin
          </Button>
          <Button
            variant="outline"
            radius="xl"
            size="md"
            leftSection={<IconBox size={18} />}
            disabled={
              !selectedSet || !selectedBinId || anyLoading || assigningUnassigned
            }
            loading={assigningUnassigned}
            onClick={handleAssignUnassignedToBin}
          >
            Push unassigned to bin
          </Button>
        </Group>
      </Paper>

      {anyLoading && (
        <Group justify="center" mt="md">
          <Loader />
        </Group>
      )}

      {!anyLoading && selectedSet && (
        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Box>
              <Text fw={600} size="sm">
                Items in set
              </Text>
              <Text size="xs" c="dimmed">
                Showing inventory currently tagged with this set. You can still
                have multiple locations per card; this just sets a default bin
                &amp; row for all unassigned quantity.
              </Text>
            </Box>
            <Badge variant="light">
              {filteredItems.length} item
              {filteredItems.length === 1 ? "" : "s"}
            </Badge>
          </Group>

          {filteredItems.length === 0 ? (
            <Text size="sm" c="dimmed">
              No inventory items found for this set.
            </Text>
          ) : (
            <ScrollArea h={400}>
              <Table
                striped
                highlightOnHover
                withRowBorders={false}
                horizontalSpacing="sm"
                verticalSpacing="xs"
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Card</Table.Th>
                    <Table.Th>Set</Table.Th>
                    <Table.Th ta="right">Total qty</Table.Th>
                    <Table.Th ta="right">Assigned</Table.Th>
                    <Table.Th ta="right">Unassigned</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredItems.map((item) => {
                    const total = getTotalQuantity(item);
                    const assigned = getAssignedQuantity(item);
                    const unassigned = Math.max(0, total - assigned);

                    const setLabel =
                      item.setCode && item.setName
                        ? `${item.setCode} – ${item.setName}`
                        : item.setCode || item.setName || "—";

                    return (
                      <Table.Tr key={item._id}>
                        <Table.Td>
                          <Text size="sm" fw={500} lineClamp={1}>
                            {item.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {item.game || "—"} •{" "}
                            {item.isFoil ? "Foil" : "Non-foil"} •{" "}
                            {item.condition || "NM"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{setLabel}</Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text size="sm" fw={500}>
                            {total}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text size="sm">{assigned}</Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text
                            size="sm"
                            fw={600}
                            c={unassigned > 0 ? "teal" : "dimmed"}
                          >
                            {unassigned}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Paper>
      )}

      {!anyLoading && !selectedSet && (
        <Text c="dimmed" size="sm">
          Choose a set above to see your inventory and assign it into bins.
        </Text>
      )}
    </Stack>
  );
}
