import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  Table,
  Text,
  TextInput,
  Title,
  Stack,
} from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";

type Bin = {
  _id: string;
  name: string;
  rows: number;
};

type Location = {
  bin: Bin | string;
  row: number;
  quantity: number;
};

type InventoryItem = {
  _id: string;
  cardTraderId?: number;
  game?: string;
  setCode?: string;
  name?: string;
  condition?: string;
  isFoil?: boolean;
  price?: number;
  totalQuantity: number;
  locations: Location[];
};

const API_BASE = "/api";

export function InventoryView() {
  const [allItems, setAllItems] = useState<InventoryItem[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(false);

  // filters (optional)
  const [search, setSearch] = useState("");
  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<string | null>(null);

  // quick add (keep for testing)
  const [newName, setNewName] = useState("");
  const [newSetCode, setNewSetCode] = useState("");
  const [newQty, setNewQty] = useState<number | "">(1);

  // assign bins modal
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [locDrafts, setLocDrafts] = useState<
    { binId: string; row: number | ""; quantity: number | "" }[]
  >([]);

  const [syncing, setSyncing] = useState(false);

  // 👉 Fetch ALL inventory once (big limit, no server-side filters)
  async function fetchInventory() {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("page", "1");
      params.set("limit", "5000"); // big enough for your whole stock

      const res = await fetch(`${API_BASE}/inventory?${params.toString()}`);
      const data = await res.json();

      // If backend returns { items }, use that; otherwise assume array
      const items: InventoryItem[] = data.items || data || [];
      setAllItems(items);
    } catch (err) {
      console.error("Failed to fetch inventory", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchBins() {
    try {
      const res = await fetch(`${API_BASE}/bins`);
      const data = await res.json();
      setBins(data || []);
    } catch (err) {
      console.error("Failed to fetch bins", err);
    }
  }

  useEffect(() => {
    fetchInventory();
    fetchBins();
  }, []);

  async function handleQuickAdd() {
    if (!newName || newQty === "" || newQty <= 0) return;

    try {
      const res = await fetch(`${API_BASE}/inventory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          setCode: newSetCode || undefined,
          totalQuantity:
            typeof newQty === "number" ? newQty : Number(newQty),
        }),
      });

      if (!res.ok) {
        console.error("Failed to create inventory item");
        return;
      }

      setNewName("");
      setNewSetCode("");
      setNewQty(1);
      await fetchInventory();
    } catch (err) {
      console.error("Failed to create inventory item", err);
    }
  }

  async function handleSyncFromCardTrader() {
    try {
      setSyncing(true);
      const res = await fetch(`${API_BASE}/cardtrader/sync-inventory`, {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok || data.ok === false) {
        console.error("Sync failed:", data.error || "Unknown error");
        return;
      }

      await fetchInventory();
    } catch (err) {
      console.error("Failed to sync from CardTrader", err);
    } finally {
      setSyncing(false);
    }
  }

  function openAssignModal(item: InventoryItem) {
    setSelectedItem(item);
    setLocDrafts(
      item.locations.length
        ? item.locations.map((loc) => ({
            binId: typeof loc.bin === "string" ? loc.bin : loc.bin._id,
            row: loc.row,
            quantity: loc.quantity,
          }))
        : [{ binId: "", row: "", quantity: "" }]
    );
    setAssignOpen(true);
  }

  function updateDraft(
    index: number,
    patch: Partial<{ binId: string; row: number | ""; quantity: number | "" }>
  ) {
    setLocDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, ...patch } : d))
    );
  }

  function addDraftRow() {
    setLocDrafts((prev) => [...prev, { binId: "", row: "", quantity: "" }]);
  }

  function removeDraftRow(index: number) {
    setLocDrafts((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveAssignments() {
    if (!selectedItem) return;

    const cleaned = locDrafts
      .filter((d) => d.binId && d.row && d.quantity !== "")
      .map((d) => ({
        bin: d.binId,
        row: typeof d.row === "number" ? d.row : Number(d.row),
        quantity:
          typeof d.quantity === "number" ? d.quantity : Number(d.quantity),
      }));

    try {
      const res = await fetch(
        `${API_BASE}/inventory/${selectedItem._id}/assign-bins`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locations: cleaned }),
        }
      );

      if (!res.ok) {
        console.error("Failed to assign bins");
        return;
      }

      setAssignOpen(false);
      setSelectedItem(null);
      await fetchInventory();
    } catch (err) {
      console.error("Failed to assign bins", err);
    }
  }

  const binOptions = bins.map((b) => ({
    value: b._id,
    label: `${b.name} (${b.rows} rows)`,
  }));

  // 👉 Build filter options from whatever is in allItems
  const setOptions = useMemo(() => {
    const unique = Array.from(
      new Set(allItems.map((i) => i.setCode).filter(Boolean))
    ).sort();
    return [
      { value: "", label: "All sets" },
      ...unique.map((code) => ({
        value: code as string,
        label: code as string,
      })),
    ];
  }, [allItems]);

  const gameOptions = useMemo(() => {
    const unique = Array.from(
      new Set(allItems.map((i) => i.game).filter(Boolean))
    ).sort();
    return [
      { value: "", label: "All games" },
      ...unique.map((g) => ({
        value: g as string,
        label: g as string,
      })),
    ];
  }, [allItems]);

  // 👉 Apply filters client-side
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      if (selectedSet && selectedSet !== "" && item.setCode !== selectedSet) {
        return false;
      }
      if (selectedGame && selectedGame !== "" && item.game !== selectedGame) {
        return false;
      }
      if (search.trim()) {
        const s = search.trim().toLowerCase();
        const name = (item.name || "").toLowerCase();
        const set = (item.setCode || "").toLowerCase();
        const game = (item.game || "").toLowerCase();
        const ctId = item.cardTraderId ? String(item.cardTraderId) : "";
        if (
          !name.includes(s) &&
          !set.includes(s) &&
          !game.includes(s) &&
          !ctId.includes(s)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [allItems, selectedSet, selectedGame, search]);

  return (
    <Box p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Inventory</Title>
          <Text c="dimmed" size="sm">
            Seeded from CardTrader into Mongo. Showing all items, with optional
            filters.
          </Text>
        </div>
        <Group align="flex-end">
          <Button
            loading={syncing}
            variant="light"
            onClick={handleSyncFromCardTrader}
          >
            Sync from CardTrader
          </Button>
        </Group>
      </Group>

      {/* Filters */}
      <Card withBorder radius="lg" mb="lg">
        <Group align="flex-end" justify="space-between" wrap="wrap">
          <Group align="flex-end" gap="md" wrap="wrap">
            <TextInput
              label="Search"
              placeholder="Name, set, game, CardTrader ID…"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              leftSection={<IconSearch size={16} />}
              rightSection={
                search ? (
                  <IconX
                    size={14}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSearch("")}
                  />
                ) : null
              }
              w={260}
            />

            <Select
              label="Set"
              data={setOptions}
              value={selectedSet ?? ""}
              onChange={(val) => setSelectedSet(val || null)}
              w={180}
            />

            <Select
              label="Game"
              data={gameOptions}
              value={selectedGame ?? ""}
              onChange={(val) => setSelectedGame(val || null)}
              w={180}
            />
          </Group>

          <Group align="flex-end">
            <Badge variant="light">
              Total items: {allItems.length}
            </Badge>
            <Badge variant="light">
              Showing: {filteredItems.length}
            </Badge>
          </Group>
        </Group>
      </Card>

      {/* Quick add test item */}
      <Card withBorder radius="lg" mb="lg">
        <Title order={4} mb="sm">
          Quick add test item
        </Title>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Name"
            placeholder="Lightning Bolt"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            w={220}
          />
          <TextInput
            label="Set code"
            placeholder="lea, mh3, war, etc. (optional)"
            value={newSetCode}
            onChange={(e) => setNewSetCode(e.currentTarget.value)}
            w={180}
          />
          <NumberInput
            label="Quantity"
            min={1}
            value={newQty}
            w={140}
            onChange={(val) =>
              setNewQty(val === "" ? "" : Number(val))
            }
          />
          <Button onClick={handleQuickAdd}>Add item</Button>
        </Group>
      </Card>

      {loading && <Text c="dimmed">Loading inventory…</Text>}

      {!loading && filteredItems.length === 0 && (
        <Text c="dimmed">
          No inventory found with these filters. Clear filters to see
          everything.
        </Text>
      )}

      {filteredItems.length > 0 && (
        <Card withBorder radius="lg">
          <ScrollArea>
            <Table striped highlightOnHover withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Set</Table.Th>
                  <Table.Th>Game</Table.Th>
                  <Table.Th>Total Qty</Table.Th>
                  <Table.Th>Locations</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filteredItems.map((item) => (
                  <Table.Tr key={item._id}>
                    <Table.Td>
                      <Text fw={500}>{item.name || "(no name)"}</Text>
                      <Group gap="xs" mt={2}>
                        {item.cardTraderId && (
                          <Text size="xs" c="dimmed">
                            CT ID: {item.cardTraderId}
                          </Text>
                        )}
                        {item.condition && (
                          <Badge size="xs" variant="outline">
                            {item.condition}
                          </Badge>
                        )}
                        {item.isFoil && (
                          <Badge size="xs" color="yellow" variant="outline">
                            Foil
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text>{item.setCode || "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text>{item.game || "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text>{item.totalQuantity}</Text>
                    </Table.Td>
                    <Table.Td>
                      {item.locations.length === 0 ? (
                        <Text size="sm" c="dimmed">
                          Not assigned
                        </Text>
                      ) : (
                        <Group gap="xs">
                          {item.locations.map((loc, idx) => {
                            const binObj =
                              typeof loc.bin === "string"
                                ? bins.find((b) => b._id === loc.bin)
                                : loc.bin;
                            return (
                              <Badge key={idx} variant="light" radius="xl">
                                {binObj?.name || "Bin"} – row {loc.row} – qty{" "}
                                {loc.quantity}
                              </Badge>
                            );
                          })}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => openAssignModal(item)}
                      >
                        Assign bins
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Card>
      )}

      {/* Assign bins modal */}
      <Modal
        opened={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={
          selectedItem
            ? `Assign bins: ${selectedItem.name || selectedItem._id}`
            : "Assign bins"
        }
        size="lg"
        centered
      >
        <Stack gap="sm">
          {locDrafts.map((draft, index) => {
            const selectedBin = bins.find((b) => b._id === draft.binId);
            const rowOptions =
              selectedBin != null
                ? Array.from({ length: selectedBin.rows }, (_, i) => ({
                    value: String(i + 1),
                    label: `Row ${i + 1}`,
                  }))
                : [];

            return (
              <Card key={index} withBorder radius="md">
                <Group align="flex-end" justify="space-between" wrap="wrap">
                  <Select
                    label="Bin"
                    placeholder="Select bin"
                    data={binOptions}
                    value={draft.binId}
                    onChange={(val) =>
                      updateDraft(index, { binId: val || "" })
                    }
                    w={220}
                  />
                  <Select
                    label="Row"
                    placeholder="Select row"
                    data={rowOptions}
                    value={draft.row === "" ? "" : String(draft.row)}
                    onChange={(val) =>
                      updateDraft(index, {
                        row: val ? Number(val) : "",
                      })
                    }
                    w={120}
                    disabled={!selectedBin}
                  />
                  <NumberInput
                    label="Quantity"
                    min={0}
                    value={draft.quantity}
                    w={140}
                    onChange={(val) =>
                      updateDraft(index, {
                        quantity: val === "" ? "" : Number(val),
                      })
                    }
                  />
                  <Button
                    variant="subtle"
                    color="red"
                    onClick={() => removeDraftRow(index)}
                  >
                    Remove
                  </Button>
                </Group>
              </Card>
            );
          })}

          <Group justify="space-between" mt="sm">
            <Button variant="light" onClick={addDraftRow}>
              Add another location
            </Button>
            <Group>
              <Button variant="default" onClick={() => setAssignOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveAssignments}>
                Save assignments
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
