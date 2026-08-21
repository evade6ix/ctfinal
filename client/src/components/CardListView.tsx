import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Image,
  Loader,
  Modal,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCards,
  IconMapPin,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";

type Bin = {
  _id?: string;
  name?: string;
  label?: string;
};

type InventoryLocation = {
  bin: string | Bin | null;
  row: number;
  quantity: number;
};

type CardListItem = {
  _id: string;
  cardTraderId?: number;
  blueprintId?: number;
  name: string;
  setCode?: string;
  setName?: string;
  rarity?: string;
  collectorNumber?: string;
  game?: string;
  condition?: string;
  isFoil?: boolean;
  price?: number;
  totalQuantity: number;
  assignedQuantity: number;
  unassignedQuantity: number;
  imageUrl?: string | null;
  locations?: InventoryLocation[];
};

type SelectOption = {
  value: string;
  label: string;
};

type CardListResponse = {
  items: CardListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: {
    sets: SelectOption[];
    conditions: string[];
    rarities: string[];
    games: string[];
  };
  summary: {
    totalSkus: number;
    totalQuantity: number;
    inventoryValue: number;
  };
};

type DeleteResponse = {
  ok?: boolean;
  error?: string;
  deleted?: {
    id: string;
    name?: string;
  };
};

const PAGE_SIZE = 10;

const SORT_OPTIONS: SelectOption[] = [
  { value: "quantity_desc", label: "Quantity: high to low" },
  { value: "quantity_asc", label: "Quantity: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "set_asc", label: "Set: A to Z" },
  { value: "set_desc", label: "Set: Z to A" },
  { value: "name_asc", label: "Card name: A to Z" },
  { value: "name_desc", label: "Card name: Z to A" },
  { value: "rarity_asc", label: "Rarity: A to Z" },
  { value: "updated_desc", label: "Recently updated" },
];

const FOIL_OPTIONS: SelectOption[] = [
  { value: "all", label: "All finishes" },
  { value: "foil", label: "Foil only" },
  { value: "nonfoil", label: "Non-foil only" },
];

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `$${Number(value).toFixed(2)}`;
}

function wholeNumber(value: number | null | undefined) {
  return Math.max(0, Number(value) || 0).toLocaleString();
}

function binLabel(bin: InventoryLocation["bin"]) {
  if (!bin) return "Unassigned";
  if (typeof bin === "string") return `Bin ${bin.slice(-6)}`;
  return bin.label || bin.name || `Bin ${String(bin._id || "").slice(-6)}`;
}

export function CardListView() {
  const [items, setItems] = useState<CardListItem[]>([]);
  const [filterOptions, setFilterOptions] = useState<CardListResponse["filters"]>({
    sets: [],
    conditions: [],
    rarities: [],
    games: [],
  });
  const [summary, setSummary] = useState<CardListResponse["summary"]>({
    totalSkus: 0,
    totalQuantity: 0,
    inventoryValue: 0,
  });

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [setCode, setSetCode] = useState<string | null>(null);
  const [condition, setCondition] = useState<string | null>(null);
  const [rarity, setRarity] = useState<string | null>(null);
  const [game, setGame] = useState<string | null>(null);
  const [foil, setFoil] = useState("all");
  const [sort, setSort] = useState("quantity_desc");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<CardListItem | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadCards() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort,
          foil,
        });

        if (debouncedQuery) params.set("search", debouncedQuery);
        if (setCode) params.set("setCode", setCode);
        if (condition) params.set("condition", condition);
        if (rarity) params.set("rarity", rarity);
        if (game) params.set("game", game);

        const response = await fetch(`/api/card-list?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = (await response.json()) as CardListResponse & {
          error?: string;
        };

        if (!response.ok) {
          throw new Error(data.error || "Failed to load card inventory");
        }

        setItems(Array.isArray(data.items) ? data.items : []);
        setFilterOptions(
          data.filters || { sets: [], conditions: [], rarities: [], games: [] }
        );
        setSummary(
          data.summary || { totalSkus: 0, totalQuantity: 0, inventoryValue: 0 }
        );
        setTotal(Number(data.total) || 0);
        setTotalPages(Math.max(1, Number(data.totalPages) || 1));

        if (Number(data.page) > 0 && Number(data.page) !== page) {
          setPage(Number(data.page));
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Failed to load cards";
        setError(message);
        setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadCards();
    return () => controller.abort();
  }, [
    condition,
    debouncedQuery,
    foil,
    game,
    page,
    rarity,
    reloadKey,
    setCode,
    sort,
  ]);

  const conditionOptions = useMemo(
    () => filterOptions.conditions.map((value) => ({ value, label: value })),
    [filterOptions.conditions]
  );

  const rarityOptions = useMemo(
    () => filterOptions.rarities.map((value) => ({ value, label: value })),
    [filterOptions.rarities]
  );

  const gameOptions = useMemo(
    () => filterOptions.games.map((value) => ({ value, label: value })),
    [filterOptions.games]
  );

  function resetPage() {
    setPage(1);
  }

  async function deleteSelectedItem() {
    if (!selectedItem || deleting) return;

    const confirmed = window.confirm(
      `Permanently delete "${selectedItem.name}" from CTFinal's MongoDB inventory?\n\n` +
        "This removes the local inventory record and all of its saved bin locations. " +
        "It does not delete anything from CardTrader or ManaPool."
    );

    if (!confirmed) return;

    const itemToDelete = selectedItem;

    try {
      setDeleting(true);
      setError(null);
      setSuccessMessage(null);

      const response = await fetch(
        `/api/card-list/${encodeURIComponent(itemToDelete._id)}`,
        { method: "DELETE" }
      );
      const data = (await response.json()) as DeleteResponse;

      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to delete inventory item");
      }

      setSelectedItem(null);
      setSuccessMessage(
        `${itemToDelete.name} was permanently removed from CTFinal's MongoDB inventory.`
      );

      if (items.length === 1 && page > 1) {
        setPage((currentPage) => Math.max(1, currentPage - 1));
      } else {
        setReloadKey((current) => current + 1);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to delete inventory item";
      setError(message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Stack gap="md">
      <Box>
        <Title order={2}>Card List</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Browse your live inventory as a visual catalogue. Open any card to see
          every bin and row where its quantity is stored.
        </Text>
      </Box>

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <Paper withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Unique listings
          </Text>
          <Text fw={800} size="xl">
            {wholeNumber(summary.totalSkus)}
          </Text>
        </Paper>
        <Paper withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Total cards
          </Text>
          <Text fw={800} size="xl">
            {wholeNumber(summary.totalQuantity)}
          </Text>
        </Paper>
        <Paper withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Listed inventory value
          </Text>
          <Text fw={800} size="xl">
            {money(summary.inventoryValue)}
          </Text>
        </Paper>
      </SimpleGrid>

      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group grow align="flex-end" wrap="wrap">
            <TextInput
              label="Search inventory"
              placeholder="Card, set, rarity, collector number..."
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              leftSection={<IconSearch size={17} />}
              miw={260}
            />
            <Select
              label="Sort"
              data={SORT_OPTIONS}
              value={sort}
              onChange={(value) => {
                setSort(value || "quantity_desc");
                resetPage();
              }}
              allowDeselect={false}
              miw={220}
            />
          </Group>

          <Group grow align="flex-end" wrap="wrap">
            <Select
              label="Set"
              placeholder="All sets"
              data={filterOptions.sets}
              value={setCode}
              onChange={(value) => {
                setSetCode(value);
                resetPage();
              }}
              searchable
              clearable
              nothingFoundMessage="No sets"
            />
            <Select
              label="Condition"
              placeholder="All conditions"
              data={conditionOptions}
              value={condition}
              onChange={(value) => {
                setCondition(value);
                resetPage();
              }}
              clearable
            />
            <Select
              label="Rarity"
              placeholder="All rarities"
              data={rarityOptions}
              value={rarity}
              onChange={(value) => {
                setRarity(value);
                resetPage();
              }}
              searchable
              clearable
            />
            <Select
              label="Game"
              placeholder="All games"
              data={gameOptions}
              value={game}
              onChange={(value) => {
                setGame(value);
                resetPage();
              }}
              searchable
              clearable
            />
            <Select
              label="Finish"
              data={FOIL_OPTIONS}
              value={foil}
              onChange={(value) => {
                setFoil(value || "all");
                resetPage();
              }}
              allowDeselect={false}
            />
          </Group>
        </Stack>
      </Paper>

      {error && (
        <Alert
          color="red"
          variant="light"
          radius="md"
          icon={<IconAlertTriangle size={18} />}
        >
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert color="teal" variant="light" radius="md">
          {successMessage}
        </Alert>
      )}

      {loading ? (
        <Center py={80}>
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Paper withBorder radius="md" p="xl">
          <Center>
            <Stack align="center" gap="xs">
              <IconCards size={38} opacity={0.45} />
              <Text fw={700}>No cards match these filters</Text>
              <Text size="sm" c="dimmed">
                Try another search, set, condition, rarity, or finish.
              </Text>
            </Stack>
          </Center>
        </Paper>
      ) : (
        <>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Showing {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, total)} of {wholeNumber(total)} listings
            </Text>
            <Text size="xs" c="dimmed">
              10 cards per page
            </Text>
          </Group>

          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 5 }} spacing="md">
            {items.map((item) => (
              <Card
                key={item._id}
                withBorder
                radius="lg"
                padding="sm"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedItem(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedItem(item);
                  }
                }}
                style={{ cursor: "pointer", overflow: "hidden" }}
              >
                <Card.Section>
                  <Box
                    pos="relative"
                    bg="var(--mantine-color-gray-1)"
                    style={{ aspectRatio: "5 / 7", overflow: "hidden" }}
                  >
                    <Image
                      src={item.imageUrl || undefined}
                      alt={item.name}
                      w="100%"
                      h="100%"
                      fit="contain"
                      fallbackSrc="https://placehold.co/500x700?text=No+Image"
                    />
                    <Badge
                      pos="absolute"
                      top={10}
                      right={10}
                      size="lg"
                      radius="xl"
                      variant="filled"
                    >
                      ×{wholeNumber(item.totalQuantity)}
                    </Badge>
                  </Box>
                </Card.Section>

                <Stack gap={6} mt="sm">
                  <Text fw={750} lineClamp={2} mih={44}>
                    {item.name}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {item.setCode || "No set code"}
                    {item.setName ? ` – ${item.setName}` : ""}
                  </Text>
                  <Group gap={6} wrap="wrap">
                    <Badge size="sm" variant="light" color="gray">
                      {item.rarity || "Rarity —"}
                    </Badge>
                    <Badge
                      size="sm"
                      variant="light"
                      color={item.isFoil ? "yellow" : "blue"}
                    >
                      {item.isFoil ? "Foil" : "Non-foil"}
                    </Badge>
                  </Group>
                  <Divider />
                  <Group justify="space-between" align="flex-end" wrap="nowrap">
                    <Box>
                      <Text size="xs" c="dimmed">
                        {item.condition || "Condition —"}
                      </Text>
                      <Text fw={800}>{money(item.price)}</Text>
                    </Box>
                    <Group gap={4} wrap="nowrap">
                      <IconMapPin size={15} />
                      <Text size="xs" fw={600}>
                        {item.locations?.length || 0} location
                        {(item.locations?.length || 0) === 1 ? "" : "s"}
                      </Text>
                    </Group>
                  </Group>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>

          {totalPages > 1 && (
            <Group justify="center" py="md">
              <Pagination value={page} onChange={setPage} total={totalPages} />
            </Group>
          )}
        </>
      )}

      <Modal
        opened={selectedItem !== null}
        onClose={() => setSelectedItem(null)}
        title={selectedItem?.name || "Card details"}
        size="lg"
        centered
        closeOnClickOutside={!deleting}
        closeOnEscape={!deleting}
        withCloseButton={!deleting}
      >
        {selectedItem && (
          <Stack gap="md">
            <Group align="flex-start" wrap="nowrap">
              <Image
                src={selectedItem.imageUrl || undefined}
                alt={selectedItem.name}
                w={190}
                h={266}
                fit="contain"
                radius="md"
                fallbackSrc="https://placehold.co/500x700?text=No+Image"
              />

              <Stack gap="xs" style={{ flex: 1 }}>
                <Title order={3}>{selectedItem.name}</Title>
                <Text size="sm" c="dimmed">
                  {selectedItem.setCode || "No set code"}
                  {selectedItem.setName ? ` – ${selectedItem.setName}` : ""}
                  {selectedItem.collectorNumber
                    ? ` • #${selectedItem.collectorNumber}`
                    : ""}
                </Text>
                <Group gap="xs">
                  <Badge variant="light">
                    {selectedItem.rarity || "Rarity unavailable"}
                  </Badge>
                  <Badge
                    variant="light"
                    color={selectedItem.isFoil ? "yellow" : "blue"}
                  >
                    {selectedItem.isFoil ? "Foil" : "Non-foil"}
                  </Badge>
                  <Badge variant="light" color="gray">
                    {selectedItem.condition || "Condition unavailable"}
                  </Badge>
                </Group>

                <SimpleGrid cols={2} spacing="xs" mt="sm">
                  <Paper withBorder radius="md" p="sm">
                    <Text size="xs" c="dimmed">
                      Price
                    </Text>
                    <Text fw={800}>{money(selectedItem.price)}</Text>
                  </Paper>
                  <Paper withBorder radius="md" p="sm">
                    <Text size="xs" c="dimmed">
                      Total quantity
                    </Text>
                    <Text fw={800}>
                      {wholeNumber(selectedItem.totalQuantity)}
                    </Text>
                  </Paper>
                  <Paper withBorder radius="md" p="sm">
                    <Text size="xs" c="dimmed">
                      Assigned
                    </Text>
                    <Text fw={800}>
                      {wholeNumber(selectedItem.assignedQuantity)}
                    </Text>
                  </Paper>
                  <Paper withBorder radius="md" p="sm">
                    <Text size="xs" c="dimmed">
                      Unassigned
                    </Text>
                    <Text fw={800}>
                      {wholeNumber(selectedItem.unassignedQuantity)}
                    </Text>
                  </Paper>
                </SimpleGrid>

                <Text size="xs" c="dimmed" mt="auto">
                  CardTrader ID: {selectedItem.cardTraderId || "—"} • Blueprint ID:{" "}
                  {selectedItem.blueprintId || "—"}
                </Text>
              </Stack>
            </Group>

            <Divider />

            <Box>
              <Group justify="space-between" mb="xs">
                <Title order={4}>Inventory locations</Title>
                <Badge variant="light">
                  {selectedItem.locations?.length || 0} location
                  {(selectedItem.locations?.length || 0) === 1 ? "" : "s"}
                </Badge>
              </Group>

              {!selectedItem.locations?.length ? (
                <Alert color="yellow" variant="light" radius="md">
                  This listing has quantity, but no bin or row is assigned yet.
                </Alert>
              ) : (
                <Box style={{ overflowX: "auto" }}>
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Bin</Table.Th>
                        <Table.Th>Row</Table.Th>
                        <Table.Th ta="right">Quantity</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {selectedItem.locations.map((location, index) => (
                        <Table.Tr
                          key={`${binLabel(location.bin)}-${location.row}-${index}`}
                        >
                          <Table.Td>{binLabel(location.bin)}</Table.Td>
                          <Table.Td>{location.row}</Table.Td>
                          <Table.Td ta="right" fw={700}>
                            {wholeNumber(location.quantity)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Box>
              )}
            </Box>

            <Divider />

            <Group justify="space-between" align="center" wrap="wrap">
              <Text size="xs" c="dimmed" maw={390}>
                This permanently removes the local MongoDB inventory record and its
                bin locations. It does not send a delete request to CardTrader or
                ManaPool.
              </Text>
              <Button
                color="red"
                variant="filled"
                leftSection={<IconTrash size={17} />}
                loading={deleting}
                onClick={deleteSelectedItem}
              >
                Delete from MongoDB
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
