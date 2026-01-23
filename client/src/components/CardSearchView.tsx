import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Box,
  Button,
  Group,
  TextInput,
  Title,
  Text,
  Loader,
  ScrollArea,
  Paper,
  Select,
  MultiSelect,
  Pagination,
  Card,
  Image,
  NumberInput,
  SegmentedControl,
  Switch,
  Table,
  Checkbox,
  Badge,
  Divider,
  Alert,
  Stack, 
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconSearch,
  IconShoppingCart,
  IconTrash,
  IconAlertTriangle,
} from "@tabler/icons-react";

type GameOption = {
  value: string;
  label: string;
};

type SetOption = {
  value: string;
  label: string;
  code?: string;
};

type CatalogCard = {
  id: number | string;
  name: string;
  setName?: string;
  setCode?: string;
  rarity?: string;
  number?: string;
  language?: string;
  condition?: string;
  imageUrl?: string;
  market?: number | null;
};

type StagedItem = {
  key: string;
  blueprintId: number | string;
  name: string;
  setName?: string;
  setCode?: string;
  imageUrl?: string;
  market?: number | null;
  suggested?: number | null;
  price: number | null;
  quantity: number;
  condition: "NM" | "LP" | "MP" | "HP";
  foil: boolean;
};

type StageOptions = {
  quantity?: number;
  price?: number | null;
  condition?: "NM" | "LP" | "MP" | "HP";
  foil?: boolean;
};

const PAGE_SIZE = 50;

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function clampSuggested(market: number) {
  const s = market - 0.15;
  return Math.max(0.01, Math.round(s * 100) / 100);
}

export function CatalogSearchView() {
  // ---- GAME + SET SELECTION ----
  const [games, setGames] = useState<GameOption[]>([]);
  const [gameId, setGameId] = useState<string>("");


  const [sets, setSets] = useState<SetOption[]>([]);
  const [selectedSetIds, setSelectedSetIds] = useState<string[]>([]);

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const [loadingGames, setLoadingGames] = useState(false);
  const [loadingSets, setLoadingSets] = useState(false);
  const [loadingSearch, setLoadingSearch] = useState(false);

  const [results, setResults] = useState<CatalogCard[]>([]);
  const [total, setTotal] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // ---- STAGED INVENTORY ----
  const [staged, setStaged] = useLocalStorage<StagedItem[]>({
    key: "ct_staged_catalog_v1",
    defaultValue: [],
  });
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [pushing, setPushing] = useState(false);

  // ===== LOAD GAMES ON MOUNT =====
  useEffect(() => {
    async function fetchGames() {
      try {
        setLoadingGames(true);
        setError(null);

        const res = await fetch("/api/catalog/games");
        const contentType = res.headers.get("content-type") || "";

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Failed to load games (status ${res.status})`);
        }

        if (!contentType.includes("application/json")) {
          const text = await res.text();
          throw new Error(
            `Expected JSON from /api/catalog/games but got: ${text.slice(
              0,
              200
            )}`
          );
        }

        const data = await res.json();
        const arr = Array.isArray(data)
          ? data
          : Array.isArray(data.games)
          ? data.games
          : [];

        const mapped: GameOption[] = arr.map((g: any) => ({
          value: String(g.id),
          label: String(g.display_name || g.displayName || g.name || "Unknown Game"),
        }));

        setGames(mapped);

        // auto-select first game
        if (mapped.length > 0) {
          setGameId(mapped[0].value);
        }
      } catch (err: any) {
        console.error("Error loading games:", err);
        setError(err.message || "Failed to load games");
      } finally {
        setLoadingGames(false);
      }
    }

    fetchGames();
  }, []);

  // ===== LOAD SETS WHEN GAME CHANGES =====
  useEffect(() => {
    if (!gameId) {
      setSets([]);
      setSelectedSetIds([]);
      return;
    }

    async function fetchSets() {
      try {
        setLoadingSets(true);
        setError(null);

        const res = await fetch(`/api/catalog/sets?gameId=${encodeURIComponent(
          gameId
        )}`);
        const contentType = res.headers.get("content-type") || "";

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Failed to load sets (status ${res.status})`);
        }

        if (!contentType.includes("application/json")) {
          const text = await res.text();
          throw new Error(
            `Expected JSON from /api/catalog/sets but got: ${text.slice(
              0,
              200
            )}`
          );
        }

        const data = await res.json();
        const arr = Array.isArray(data)
          ? data
          : Array.isArray(data.sets)
          ? data.sets
          : [];

        const mapped: SetOption[] = arr.map((s: any) => ({
          value: String(s.id),
          label: s.code ? `${s.code} – ${s.name}` : String(s.name || "Unknown"),
          code: s.code,
        }));

        setSets(mapped);
        setSelectedSetIds([]);
      } catch (err: any) {
        console.error("Error loading sets:", err);
        setError(err.message || "Failed to load sets");
      } finally {
        setLoadingSets(false);
      }
    }

    fetchSets();
  }, [gameId]);

  // ===== SEARCH =====
  async function runSearch(targetPage?: number) {
    if (!gameId) {
      setError("Please choose a game first.");
      return;
    }
    if (selectedSetIds.length === 0) {
      setError("Please choose at least one set.");
      return;
    }

    const pageToUse = targetPage ?? page;

    setLoadingSearch(true);
    setError(null);
    setHasSearched(true);

    try {
      const body = {
        gameId,
        setIds: selectedSetIds,
        query: query.trim() || null,
        page: pageToUse,
        pageSize: PAGE_SIZE,
      };

      const res = await fetch("/api/catalog/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const contentType = res.headers.get("content-type") || "";

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          text || `Search failed with status ${res.status} on the backend`
        );
      }

      if (!contentType.includes("application/json")) {
        const text = await res.text();
        throw new Error(
          `Expected JSON from /api/catalog/search but got: ${text.slice(
            0,
            200
          )}`
        );
      }

      const data = await res.json();

      const rawItems: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data.items)
        ? data.items
        : [];

      const items: CatalogCard[] = rawItems.map((c: any) => {
        const id = c.id ?? c.blueprint_id ?? `${c.setCode}-${c.name}`;
        const marketRaw =
          typeof c.market === "number"
            ? c.market
            : typeof c.marketPrice === "number"
            ? c.marketPrice
            : null;

        return {
          id,
          name: c.name ?? "Unknown Card",
          setName: c.setName ?? c.expansion_name,
          setCode: c.setCode ?? c.expansion_code,
          rarity: c.rarity,
          number: c.collectorNumber ?? c.number,
          language: c.language,
          condition: c.condition,
          imageUrl:
            c.image_url ||
            c.imageUrl ||
            c.image ||
            (Array.isArray(c.images) ? c.images[0]?.url : undefined),
          market: marketRaw,
        };
      });

      const totalFromServer =
        typeof data.total === "number" ? data.total : items.length;

      setResults(items);
      setTotal(totalFromServer);
      setPage(pageToUse);
    } catch (err: any) {
      console.error("Catalog search error:", err);
      setError(err.message || "Failed to search catalog");
      setResults([]);
      setTotal(0);
    } finally {
      setLoadingSearch(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    runSearch(1);
  }

  function onPageChange(newPage: number) {
    runSearch(newPage);
  }

  const totalPages =
    total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  // ===== STAGING HELPERS =====
  function stageCard(card: CatalogCard, opts?: StageOptions) {
    const market = card.market ?? null;
    const suggested = market != null ? clampSuggested(market) : null;

    const quantity = Math.max(
      1,
      Math.floor(Number(opts?.quantity ?? 1) || 1)
    );

    const priceFromOpts =
      opts?.price != null && Number.isFinite(opts.price as number)
        ? (opts.price as number)
        : suggested;

    const newItem: StagedItem = {
      key: `${card.id}-${Date.now()}`,
      blueprintId: card.id,
      name: card.name,
      setName: card.setName,
      setCode: card.setCode,
      imageUrl: card.imageUrl,
      market,
      suggested,
      price: priceFromOpts ?? null,
      quantity,
      condition: opts?.condition ?? "NM",
      foil: opts?.foil ?? false,
    };

    setStaged((prev) => [newItem, ...prev]);

    notifications.show({
      title: "Staged",
      message: `${card.name} added to staged inventory.`,
    });
  }

  function updateStaged(key: string, patch: Partial<StagedItem>) {
    setStaged((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  function removeStaged(key: string) {
    setStaged((prev) => prev.filter((x) => x.key !== key));
    setSelectedKeys((prev) => prev.filter((k) => k !== key));
  }

  function toggleSelected(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function clearSelected() {
    setSelectedKeys([]);
  }

  function bulkPatch(patch: Partial<StagedItem>) {
    if (selectedKeys.length === 0) return;
    setStaged((prev) =>
      prev.map((x) => (selectedKeys.includes(x.key) ? { ...x, ...patch } : x))
    );
  }

  const stagedCount = staged.length;

  const stagedTotals = useMemo(() => {
    const totalQty = staged.reduce((sum, x) => sum + (x.quantity || 0), 0);

    const totalValue = staged.reduce((sum, x) => {
      const qty = x.quantity || 0;
      const price = x.price ?? null;
      if (price == null || !Number.isFinite(price)) return sum;
      return sum + qty * price;
    }, 0);

    return { totalQty, totalValue };
  }, [staged]);

  const stageHealth = useMemo(() => {
    const ok = staged.filter(
      (x) => (x.quantity ?? 0) > 0 && (x.price ?? 0) > 0
    ).length;
    return {
      ok,
      total: staged.length,
      pct: staged.length ? Math.round((ok / staged.length) * 100) : 0,
    };
  }, [staged]);

  // ===== PUSH ALL LIVE → CARDTRADER =====
  async function pushAllLive() {
    if (staged.length === 0) return;

    const items = staged
      .map((x) => ({
        blueprintId: x.blueprintId,
        quantity: x.quantity,
        price: x.price,
        condition: x.condition,
        foil: x.foil,
      }))
      .filter((x) => {
        const okId = !!x.blueprintId;
        const okQty = Number.isFinite(x.quantity) && x.quantity > 0;
        const okPrice =
          typeof x.price === "number" && Number.isFinite(x.price) && x.price > 0;
        return okId && okQty && okPrice;
      });

    if (items.length === 0) {
      notifications.show({
        title: "Nothing to push",
        message: "All staged items need a valid price and quantity.",
        color: "red",
      });
      return;
    }

    try {
      setPushing(true);

      const res = await fetch("/api/ct/products/push-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.message ||
            `Push failed with status ${res.status}`
        );
      }

      const created = data?.created ?? 0;
      const failed = data?.failed ?? 0;

      if (failed > 0) {
        notifications.show({
          title: "Partial push",
          message: `Created ${created}, failed ${failed}. Check server logs for details.`,
          color: "yellow",
        });
        console.log("Push All Live report:", data);
        return;
      }

      notifications.show({
        title: "Pushed live",
        message: `Created ${created} listings on CardTrader.`,
        color: "green",
      });

      setStaged([]);
      setSelectedKeys([]);
    } catch (e: any) {
      console.error("Push failed", e);
      notifications.show({
        title: "Push failed",
        message: e?.message || "Request failed",
        color: "red",
      });
    } finally {
      setPushing(false);
    }
  }

  return (
    <Box>
      {/* HEADER */}
      <Box mb="md">
        <Title order={2}>CardTrader Catalog Search</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Choose a game, pick one or more sets, then search. Results show{" "}
          <strong>CardTrader blueprints</strong>. Stage them with prices/qty, then
          push live.
        </Text>
      </Box>

      {/* SEARCH PANEL */}
      <Paper withBorder p="md" radius="md" mb="md">
        <form onSubmit={onSubmit}>
          <Box>
            <Group grow wrap="wrap">
              <Select
  label="Game"
  placeholder={
    loadingGames ? "Loading games..." : "Select a game"
  }
  data={games}
  value={gameId}
  onChange={(val: string | null) => {
    setGameId(val || "");
    setPage(1);
  }}
  disabled={loadingGames}
  searchable
  nothingFoundMessage="No games"
/>


              <MultiSelect
                label="Sets"
                placeholder={
                  !gameId
                    ? "Select a game first"
                    : loadingSets
                    ? "Loading sets..."
                    : "Select one or more sets"
                }
                data={sets}
                value={selectedSetIds}
                onChange={(values) => {
                  setSelectedSetIds(values);
                  setPage(1);
                }}
                searchable
                disabled={!gameId || loadingSets}
                nothingFoundMessage={
                  gameId ? "No sets for this game" : "Select a game first"
                }
              />
            </Group>

            <Group align="flex-end" gap="sm" wrap="wrap" mt="sm">
              <TextInput
                label="Card name (optional)"
                placeholder="Ragavan, Nimble Pilferer"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                leftSection={<IconSearch size={18} />}
                style={{ flex: 1, minWidth: "260px" }}
              />
              <Button
                type="submit"
                disabled={
                  !gameId || selectedSetIds.length === 0 || loadingSearch
                }
                leftSection={
                  !loadingSearch ? <IconSearch size={18} /> : undefined
                }
              >
                {loadingSearch ? <Loader size="xs" /> : "Search"}
              </Button>
            </Group>
          </Box>
        </form>
      </Paper>

      {error && (
        <Text c="red" size="sm" mb="sm">
          {error}
        </Text>
      )}

      {/* SEARCH RESULTS */}
      <Box mb="xl">
        <Group justify="space-between" align="center" mb="sm">
          <Text fw={700}>Search results</Text>
          {total > 0 && (
            <Text size="xs" c="dimmed">
              Showing {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, total)} of {total} results
            </Text>
          )}
        </Group>

        {loadingSearch && (
          <Group justify="center" mt="md">
            <Loader />
          </Group>
        )}

        {!loadingSearch && hasSearched && results.length === 0 && !error && (
          <Text c="dimmed" size="sm">
            No results found for this combination.
          </Text>
        )}

        {!loadingSearch && results.length > 0 && (
          <StackResults
            results={results}
            onStage={stageCard}
          />
        )}

        {!loadingSearch && results.length > 0 && totalPages > 1 && (
          <Box mt="sm">
            <Pagination
              value={page}
              onChange={onPageChange}
              total={totalPages}
              size="sm"
            />
          </Box>
        )}
      </Box>

      {/* STAGED INVENTORY */}
      <Box>
        <Group justify="space-between" align="flex-end" mb="sm">
          <Box>
            <Text fw={700}>Staged inventory</Text>
            <Text size="xs" c="dimmed">
              Validate qty, price, condition & foil, then push live to CardTrader.
            </Text>
          </Box>
          <Group gap="xs">
            <Badge variant="light" radius="md">
              {stagedCount} items
            </Badge>
            <Badge variant="light" radius="md">
              {stageHealth.pct}% valid
            </Badge>
          </Group>
        </Group>

        <Card withBorder radius="md" p="md">
          <Group justify="space-between" align="center" mb="sm">
            <Text size="sm" c="dimmed">
              Total qty:{" "}
              <Text span fw={900}>
                {stagedTotals.totalQty.toLocaleString()}
              </Text>{" "}
              • Total value:{" "}
              <Text span fw={900}>{money(stagedTotals.totalValue)}</Text>
            </Text>

            <Group gap="xs">
              <Button
                size="xs"
                variant="light"
                disabled={selectedKeys.length === 0 || pushing}
                onClick={() => bulkPatch({ condition: "NM" })}
              >
                Bulk NM
              </Button>
              <Button
                size="xs"
                variant="light"
                disabled={selectedKeys.length === 0 || pushing}
                onClick={() => bulkPatch({ foil: true })}
              >
                Bulk Foil=On
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={selectedKeys.length === 0 || pushing}
                onClick={clearSelected}
              >
                Clear selection
              </Button>
              <Button
                size="xs"
                leftSection={<IconShoppingCart size={14} />}
                onClick={pushAllLive}
                disabled={staged.length === 0 || pushing}
                loading={pushing}
              >
                Push Live (CT)
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                disabled={staged.length === 0 || pushing}
                onClick={() => {
                  setStaged([]);
                  setSelectedKeys([]);
                }}
              >
                Clear staged
              </Button>
            </Group>
          </Group>

          {staged.length === 0 ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="gray"
              variant="light"
              radius="md"
            >
              Nothing staged yet. Use the search above and click <b>Stage</b> to
              build a batch.
            </Alert>
          ) : (
            <ScrollArea h={360}>
              <Table
                verticalSpacing="sm"
                highlightOnHover
                striped
                stickyHeader
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 32 }} />
                    <Table.Th>Card</Table.Th>
                    <Table.Th>Set</Table.Th>
                    <Table.Th>Market</Table.Th>
                    <Table.Th>Suggested</Table.Th>
                    <Table.Th>Qty</Table.Th>
                    <Table.Th>Price</Table.Th>
                    <Table.Th>Cond</Table.Th>
                    <Table.Th>Foil</Table.Th>
                    <Table.Th style={{ width: 80 }} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {staged.map((x) => (
                    <Table.Tr key={x.key}>
                      <Table.Td>
                        <Checkbox
                          checked={selectedKeys.includes(x.key)}
                          onChange={() => toggleSelected(x.key)}
                          disabled={pushing}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Group wrap="nowrap">
                          <Image
                            src={x.imageUrl}
                            w={40}
                            h={56}
                            radius="sm"
                            fit="contain"
                            fallbackSrc="https://placehold.co/80x112?text=Card"
                          />
                          <Box>
                            <Text fw={700} lineClamp={1}>
                              {x.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              Blueprint #{x.blueprintId}
                            </Text>
                          </Box>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>
                          {x.setName}
                          {x.setCode ? ` (${x.setCode})` : ""}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={700}>
                          {money(x.market ?? null)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={700}>
                          {money(x.suggested ?? null)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          value={x.quantity}
                          onChange={(v) => {
                            const num =
                              typeof v === "number"
                                ? v
                                : typeof v === "string"
                                ? Number(v)
                                : 1;
                            const q = Number.isFinite(num)
                              ? Math.max(1, Math.floor(num))
                              : 1;
                            updateStaged(x.key, { quantity: q });
                          }}
                          min={1}
                          step={1}
                          clampBehavior="strict"
                          w={80}
                          disabled={pushing}
                          radius="md"
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          value={x.price ?? undefined}
                          onChange={(v) => {
                            const num =
                              typeof v === "number"
                                ? v
                                : typeof v === "string"
                                ? Number(v)
                                : null;

                            updateStaged(x.key, {
                              price: Number.isFinite(num as number)
                                ? (num as number)
                                : null,
                            });
                          }}
                          min={0.01}
                          step={0.01}
                          decimalScale={2}
                          fixedDecimalScale
                          prefix="$"
                          w={110}
                          disabled={pushing}
                          radius="md"
                        />
                      </Table.Td>
                      <Table.Td>
                        <SegmentedControl
                          value={x.condition}
                          onChange={(v) =>
                            updateStaged(x.key, { condition: v as any })
                          }
                          data={[
                            { label: "NM", value: "NM" },
                            { label: "LP", value: "LP" },
                            { label: "MP", value: "MP" },
                            { label: "HP", value: "HP" },
                          ]}
                          disabled={pushing}
                          size="xs"
                        />
                      </Table.Td>
                      <Table.Td>
                        <Switch
                          checked={x.foil}
                          onChange={(e) =>
                            updateStaged(x.key, {
                              foil: e.currentTarget.checked,
                            })
                          }
                          disabled={pushing}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          variant="subtle"
                          color="red"
                          size="xs"
                          onClick={() => removeStaged(x.key)}
                          leftSection={<IconTrash size={14} />}
                          disabled={pushing}
                        >
                          Remove
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Card>
      </Box>
    </Box>
  );
}

/**
 * Simple list of search results with inline "Stage" controls.
 * Each result is a card row with image, set + rarity, and qty/price/cond.
 */
function StackResults({
  results,
  onStage,
}: {
  results: CatalogCard[];
  onStage: (card: CatalogCard, opts?: StageOptions) => void;
}) {
  const [localState, setLocalState] = useState<
    Record<
      string,
      {
        qty: number;
        price: number | null;
        condition: "NM" | "LP" | "MP" | "HP";
        foil: boolean;
      }
    >
  >({});

  return (
    <Stack gap="sm">
      {results.map((card) => {
        const key = String(card.id);
        const ls = localState[key] || {
          qty: 1,
          price: card.market != null ? clampSuggested(card.market) : null,
          condition: "NM" as const,
          foil: false,
        };

        const lineTotal =
          ls.price != null && Number.isFinite(ls.price)
            ? ls.price * (ls.qty || 0)
            : null;

        const canStage =
          ls.qty > 0 &&
          typeof ls.price === "number" &&
          Number.isFinite(ls.price) &&
          ls.price > 0;

        const update = (patch: Partial<typeof ls>) => {
          setLocalState((prev) => ({
            ...prev,
            [key]: { ...ls, ...patch },
          }));
        };

        return (
          <Paper key={card.id} withBorder radius="md" p="md">
            <Group align="flex-start" justify="space-between" wrap="nowrap">
              <Group wrap="nowrap" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
                <Image
                  src={card.imageUrl}
                  w={62}
                  h={86}
                  radius="md"
                  fit="contain"
                  fallbackSrc="https://placehold.co/124x172?text=Card"
                />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Box style={{ minWidth: 0 }}>
                      <Text fw={800} lineClamp={1}>
                        {card.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {card.setCode
                          ? `${card.setCode} – ${card.setName ?? ""}`
                          : card.setName ?? "Unknown set"}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {card.rarity ? `${card.rarity} · ` : ""}
                        {card.number ? `#${card.number} · ` : ""}
                        {card.language || "EN"}
                      </Text>
                    </Box>

                    <Box ta="right">
                      <Text size="sm">
                        Market{" "}
                        <Text span fw={800}>
                          {money(card.market ?? null)}
                        </Text>
                      </Text>
                      <Text size="sm">
                        Suggested{" "}
                        <Text span fw={800}>
                          {card.market != null
                            ? money(clampSuggested(card.market))
                            : "—"}
                        </Text>
                      </Text>
                      <Text size="sm" c="dimmed">
                        Line total{" "}
                        <Text span fw={900}>
                          {money(lineTotal)}
                        </Text>
                      </Text>
                    </Box>
                  </Group>

                  <Divider my="sm" />

                  <Group gap="md" align="flex-end" wrap="wrap">
                    <NumberInput
                      label="Qty"
                      value={ls.qty}
                      onChange={(v) => {
                        const num =
                          typeof v === "number"
                            ? v
                            : typeof v === "string"
                            ? Number(v)
                            : 1;
                        const q = Number.isFinite(num)
                          ? Math.max(1, Math.floor(num))
                          : 1;
                        update({ qty: q });
                      }}
                      min={1}
                      step={1}
                      clampBehavior="strict"
                      w={90}
                      radius="md"
                    />

                    <NumberInput
                      label="Price"
                      value={ls.price ?? undefined}
                      onChange={(v) => {
                        const num =
                          typeof v === "number"
                            ? v
                            : typeof v === "string"
                            ? Number(v)
                            : null;
                        update({
                          price: Number.isFinite(num as number)
                            ? (num as number)
                            : null,
                        });
                      }}
                      min={0.01}
                      step={0.01}
                      decimalScale={2}
                      fixedDecimalScale
                      prefix="$"
                      w={130}
                      radius="md"
                    />

                    <Box>
                      <Text size="sm" fw={700} mb={4}>
                        Condition
                      </Text>
                      <SegmentedControl
                        value={ls.condition}
                        onChange={(v) => update({ condition: v as any })}
                        data={[
                          { label: "NM", value: "NM" },
                          { label: "LP", value: "LP" },
                          { label: "MP", value: "MP" },
                          { label: "HP", value: "HP" },
                        ]}
                        size="xs"
                      />
                    </Box>

                    <Box>
                      <Text size="sm" fw={700} mb={4}>
                        Foil
                      </Text>
                      <Switch
                        checked={ls.foil}
                        onChange={(e) => update({ foil: e.currentTarget.checked })}
                      />
                    </Box>

                    <Box style={{ flex: 1 }} />

                    <Button
                      radius="xl"
                      leftSection={<IconShoppingCart size={16} />}
                      disabled={!canStage}
                      onClick={() =>
                        onStage(card, {
                          quantity: ls.qty,
                          price: ls.price,
                          condition: ls.condition,
                          foil: ls.foil,
                        })
                      }
                    >
                      Stage
                    </Button>
                  </Group>

                  {!canStage && (
                    <Alert
                      mt="sm"
                      radius="md"
                      variant="light"
                      color="yellow"
                      icon={<IconAlertTriangle size={16} />}
                    >
                      Set a valid price and quantity to stage.
                    </Alert>
                  )}
                </Box>
              </Group>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
