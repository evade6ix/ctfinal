import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Group,
  TextInput,
  Title,
  Text,
  Loader,
  Badge,
  Stack,
  Paper,
  Select,
  MultiSelect,
  Pagination,
  Image,
  NumberInput,
  SegmentedControl,
  Switch,
  Alert,
  Divider,
  Tabs,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconSearch,
  IconAlertTriangle,
  IconShoppingCart,
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

type BinOption = {
  value: string;
  label: string;
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
  market?: number | null; // ✅ market price from backend
};

type Condition = "NM" | "LP" | "MP" | "HP";

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
  condition: Condition;
  foil: boolean;
};

const PAGE_SIZE = 50;
const STAGED_STORAGE_KEY = "ct_staged_v1";

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function clampSuggested(market: number) {
  const s = market - 0.15;
  return Math.max(0.01, Math.round(s * 100) / 100);
}

export function CatalogSearchView() {
  const [games, setGames] = useState<GameOption[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);

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

  // staged inventory (local, in-memory + localStorage)
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [pushing, setPushing] = useState(false);
  const [foilDefault, setFoilDefault] = useState(false);

  // ---- Bin / Row selection for this batch ----
  const [bins, setBins] = useState<BinOption[]>([]);
  const [loadingBins, setLoadingBins] = useState(false);
  const [binError, setBinError] = useState<string | null>(null);
  const [destBinId, setDestBinId] = useState<string | null>(null);
  const [destRow, setDestRow] = useState<number | null>(null);

  // ---- Hydrate staged from localStorage on mount ----
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const raw = window.localStorage.getItem(STAGED_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items)) {
        setStaged(parsed.items);
      }
      if (typeof parsed.foilDefault === "boolean") {
        setFoilDefault(parsed.foilDefault);
      }
    } catch (e) {
      console.error("Failed to hydrate staged from localStorage", e);
    }
  }, []);

  // ---- Persist staged to localStorage whenever it changes ----
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const payload = { items: staged, foilDefault };
      window.localStorage.setItem(STAGED_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("Failed to persist staged to localStorage", e);
    }
  }, [staged, foilDefault]);

  // ---- Staged totals ----
  const stagedTotals = useMemo(() => {
    const totalQty = staged.reduce((sum, s) => sum + (s.quantity || 0), 0);
    const totalValue = staged.reduce((sum, s) => {
      const qty = s.quantity || 0;
      const price = s.price ?? null;
      if (price == null || !Number.isFinite(price)) return sum;
      return sum + qty * price;
    }, 0);
    return { totalQty, totalValue };
  }, [staged]);

  // ---- Load games on mount ----
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
          label: String(g.displayName || g.name || "Unknown Game"),
        }));

        setGames(mapped);

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

  // ---- Load sets when gameId changes ----
  useEffect(() => {
    if (!gameId) {
      setSets([]);
      setSelectedSetIds([]);
      return;
    }

    async function fetchSets(selectedGameId: string) {
      try {
        setLoadingSets(true);
        setError(null);

        const res = await fetch(
          `/api/catalog/sets?gameId=${encodeURIComponent(selectedGameId)}`
        );
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
          label: s.code
            ? `${s.code} – ${s.name}`
            : String(s.name || "Unknown"),
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

    fetchSets(gameId);
  }, [gameId]);

  // ---- Load bins for bulk destination ----
  useEffect(() => {
    async function fetchBins() {
      try {
        setLoadingBins(true);
        setBinError(null);

        const res = await fetch("/api/bins");
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Failed to load bins (status ${res.status})`);
        }

        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];

        const mapped: BinOption[] = arr.map((b: any) => ({
          value: String(b._id),
          label: b.label || b.name || `Bin ${String(b._id).slice(-4)}`,
        }));

        setBins(mapped);
      } catch (err: any) {
        console.error("Error loading bins:", err);
        setBinError(err.message || "Failed to load bins");
      } finally {
        setLoadingBins(false);
      }
    }

    fetchBins();
  }, []);

  // ---- Run search ----
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

      const itemsRaw: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data.items)
        ? data.items
        : [];

      const mapped: CatalogCard[] = itemsRaw.map((c: any) => ({
  id: c.id ?? `${c.setCode}-${c.name}`,
  name: c.name ?? "Unknown Card",
  setName: c.setName,
  setCode: c.setCode,
  rarity: c.rarity,
  number: c.collectorNumber ?? c.number,
  language: c.language,
  condition: c.condition,
  imageUrl:
    c.image_url ||
    c.imageUrl ||
    c.image ||
    (Array.isArray(c.images) && c.images[0]?.url) ||
    undefined,
  // ✅ read market from backend if present
  market:
    typeof c.market === "number"
      ? c.market
      : typeof c.marketPrice === "number"
      ? c.marketPrice
      : null,
}));


      const totalFromServer =
        typeof data.total === "number" ? data.total : mapped.length;

      setResults(mapped);
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(1);
  }

  function onPageChange(newPage: number) {
    runSearch(newPage);
  }

  const totalPages =
    total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  // ---- Push Live (CardTrader + bin/row) ----
  async function pushLive() {
    if (staged.length === 0) return;

    if (!destBinId || destRow == null) {
      alert("Select a bulk box and row for this batch before pushing live.");
      return;
    }

    const items = staged
      .map((s) => ({
        blueprintId: s.blueprintId,
        quantity: s.quantity,
        price: s.price,
        condition: s.condition,
        foil: s.foil,
        // metadata so Mongo can show nice inventory rows (optional)
        name: s.name,
        setCode: s.setCode,
        gameId: gameId,
      }))
      .filter((it) => {
        const okId = Number.isFinite(Number(it.blueprintId));
        const okQty =
          Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0;
        const okPrice =
          typeof it.price === "number" &&
          Number.isFinite(it.price) &&
          it.price > 0;
        return okId && okQty && okPrice;
      });

    if (items.length === 0) {
      alert(
        "All staged items need a valid price and quantity before pushing live."
      );
      return;
    }

    try {
      setPushing(true);
      const res = await fetch("/api/ct/products/push-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          binId: destBinId,
          row: destRow,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        console.error("Push Live failed:", data);
        alert(
          data?.error ||
            `Push Live failed with status ${res.status}. Check console for details.`
        );
        return;
      }

      const created = data?.created ?? 0;
      const failed = data?.failed ?? 0;

      if (failed > 0) {
        console.log("Push Live report:", data);
        alert(
          `Partial push: created ${created}, failed ${failed}. See console for details.`
        );
        return;
      }

      alert(
        `Pushed ${created} listings live on CardTrader and updated inventory for the selected bin/row.`
      );
      setStaged([]);
    } catch (err: any) {
      console.error("Push Live error:", err);
      alert(err.message || "Push Live failed");
    } finally {
      setPushing(false);
    }
  }

  // ---- Stage handlers ----
  function handleStage(item: StagedItem) {
    setStaged((prev) => [item, ...prev]);
  }

  function updateStagedItem(key: string, patch: Partial<StagedItem>) {
    setStaged((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...patch } : it))
    );
  }

  function removeStagedItem(key: string) {
    setStaged((prev) => prev.filter((it) => it.key !== key));
  }

  return (
    <Stack gap="md">
      {/* HEADER */}
      <Box>
        <Title order={2}>CardTrader Catalog Search</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Choose a game, pick one or more sets, then search. This pulls{" "}
          <strong>CardTrader blueprints</strong>, not your local inventory.
        </Text>
      </Box>

      {/* STAGED SUMMARY BAR (always visible) */}
      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm">
            <Badge
              leftSection={<IconShoppingCart size={14} />}
              variant="light"
              radius="sm"
            >
              Staged: {staged.length}
            </Badge>
            <Text size="sm" c="dimmed">
              Qty:{" "}
              <Text span fw={700}>
                {stagedTotals.totalQty}
              </Text>{" "}
              • Value:{" "}
              <Text span fw={700}>{money(stagedTotals.totalValue)}</Text>
            </Text>
          </Group>

          <Group gap="sm">
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                Default foil
              </Text>
              <Switch
                size="xs"
                checked={foilDefault}
                onChange={(e) => setFoilDefault(e.currentTarget.checked)}
              />
            </Group>

            <Button
              size="sm"
              radius="xl"
              leftSection={<IconShoppingCart size={14} />}
              disabled={staged.length === 0 || pushing}
              loading={pushing}
              onClick={pushLive}
            >
              Push Live (CT)
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* TABS: SEARCH / STAGED */}
      <Tabs defaultValue="search" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="search">Search</Tabs.Tab>
          <Tabs.Tab value="staged">
            <Group gap={6}>
              <Text size="sm">Staged</Text>
              <Badge size="sm" variant="light">
                {staged.length}
              </Badge>
            </Group>
          </Tabs.Tab>
        </Tabs.List>

        {/* SEARCH TAB */}
        <Tabs.Panel value="search" pt="md">
          {/* Search form */}
          <Paper withBorder p="md" radius="md">
            <form onSubmit={onSubmit}>
              <Stack gap="sm">
                <Group grow wrap="wrap">
                  <Select
                    label="Game"
                    placeholder={
                      loadingGames ? "Loading games..." : "Select a game"
                    }
                    data={games}
                    value={gameId}
                    onChange={(val: string | null) => {
                      setGameId(val);
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

                <Group align="flex-end" gap="sm" wrap="wrap">
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
              </Stack>
            </form>
          </Paper>

          {/* Error / empty / loading / results */}
          {error && (
            <Text c="red" size="sm" mt="sm">
              {error}
            </Text>
          )}

          {!loadingSearch &&
            hasSearched &&
            results.length === 0 &&
            !error && (
              <Text c="dimmed" size="sm" mt="sm">
                No results found for this combination.
              </Text>
            )}

          {loadingSearch && (
            <Group justify="center" mt="md">
              <Loader />
            </Group>
          )}

          {!loadingSearch && results.length > 0 && (
            <Stack gap="sm" mt="md">
              {results.map((card) => (
                <CatalogResultRow
                  key={card.id}
                  card={card}
                  defaultFoil={foilDefault}
                  onStage={handleStage}
                />
              ))}

              {totalPages > 1 && (
                <Box px="md" py="xs">
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">
                      Showing {(page - 1) * PAGE_SIZE + 1}–
                      {Math.min(page * PAGE_SIZE, total)} of {total} results
                    </Text>
                    <Pagination
                      value={page}
                      onChange={onPageChange}
                      total={totalPages}
                      size="sm"
                    />
                  </Group>
                </Box>
              )}
            </Stack>
          )}
        </Tabs.Panel>

        {/* STAGED TAB */}
        <Tabs.Panel value="staged" pt="md">
          {staged.length === 0 ? (
            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="gray"
              variant="light"
              radius="md"
            >
              Nothing staged yet. Use the <b>Search</b> tab and click{" "}
              <b>Stage</b> on cards to build a batch.
            </Alert>
          ) : (
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="sm" align="flex-end">
                <Box>
                  <Title order={4}>Staged listings</Title>
                  <Text size="xs" c="dimmed">
                    Adjust quantity, price, condition, and foil before pushing
                    live. Then choose a bulk box + row for this batch.
                  </Text>
                  {binError && (
                    <Text size="xs" c="red">
                      {binError}
                    </Text>
                  )}
                </Box>

                <Group gap="xs" align="flex-end">
                  <Select
                    label="Bulk box"
                    placeholder={
                      loadingBins ? "Loading bins..." : "Select destination bin"
                    }
                    data={bins}
                    value={destBinId}
                    onChange={(val) => setDestBinId(val)}
                    searchable
                    clearable
                    disabled={loadingBins}
                    nothingFoundMessage={
                      loadingBins ? "Loading..." : "No bins configured"
                    }
                    w={180}
                  />

                  <NumberInput
  label="Row"
  value={destRow ?? undefined}
  onChange={(v) => {
    const num =
      typeof v === "number"
        ? v
        : typeof v === "string"
        ? Number(v)
        : null;

    const row =
      num != null && Number.isFinite(num as number) && (num as number) > 0
        ? Math.floor(num as number)
        : null;

    setDestRow(row);
  }}
  min={1}          // ✅ only lower-bound (no max)
  step={1}
  clampBehavior="strict"
  w={80}
/>
                </Group>
              </Group>

              <Stack gap="sm">
                {staged.map((item) => (
                  <Group
                    key={item.key}
                    align="flex-start"
                    wrap="wrap"
                    gap="md"
                  >
                    <Group gap="sm" style={{ minWidth: 0, flex: 1 }}>
                      <Image
                        src={item.imageUrl}
                        w={48}
                        h={64}
                        fit="contain"
                        radius="sm"
                        fallbackSrc="https://placehold.co/96x128?text=Card"
                      />
                      <Box style={{ minWidth: 0 }}>
                        <Text fw={600} lineClamp={1}>
                          {item.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {item.setCode
                            ? `${item.setCode} – ${item.setName ?? ""}`
                            : item.setName ?? ""}
                        </Text>
                        <Text size="xs" c="dimmed">
                          Market: {money(item.market ?? null)} • Suggested:{" "}
                          {money(item.suggested ?? null)}
                        </Text>
                      </Box>
                    </Group>

                    <NumberInput
                      label="Qty"
                      value={item.quantity}
                      onChange={(v) => {
                        const num =
                          typeof v === "number"
                            ? v
                            : typeof v === "string"
                            ? Number(v)
                            : item.quantity;
                        const q = Number.isFinite(num)
                          ? Math.max(1, Math.floor(num))
                          : 1;
                        updateStagedItem(item.key, { quantity: q });
                      }}
                      min={1}
                      step={1}
                      clampBehavior="strict"
                      w={90}
                      radius="md"
                    />

                    <NumberInput
                      label="Price"
                      value={item.price ?? undefined}
                      onChange={(v) => {
                        const num =
                          typeof v === "number"
                            ? v
                            : typeof v === "string"
                            ? Number(v)
                            : null;
                        updateStagedItem(item.key, {
                          price:
                            num != null && Number.isFinite(num as number)
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
                      <Text size="xs" fw={600} mb={4}>
                        Condition
                      </Text>
                      <SegmentedControl
                        size="xs"
                        value={item.condition}
                        onChange={(v) =>
                          updateStagedItem(item.key, {
                            condition: v as Condition,
                          })
                        }
                        data={[
                          { label: "NM", value: "NM" },
                          { label: "LP", value: "LP" },
                          { label: "MP", value: "MP" },
                          { label: "HP", value: "HP" },
                        ]}
                      />
                    </Box>

                    <Box>
                      <Text size="xs" fw={600} mb={4}>
                        Foil
                      </Text>
                      <Switch
                        size="sm"
                        checked={item.foil}
                        onChange={(e) =>
                          updateStagedItem(item.key, {
                            foil: e.currentTarget.checked,
                          })
                        }
                      />
                    </Box>

                    <Button
                      variant="subtle"
                      color="red"
                      onClick={() => removeStagedItem(item.key)}
                    >
                      Remove
                    </Button>
                  </Group>
                ))}
              </Stack>
            </Paper>
          )}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function CatalogResultRow({
  card,
  defaultFoil,
  onStage,
}: {
  card: CatalogCard;
  defaultFoil: boolean;
  onStage: (item: StagedItem) => void;
}) {
  const [qty, setQty] = useState(1);
  const [condition, setCondition] = useState<Condition>("NM");
  const [foil, setFoil] = useState(defaultFoil);

  // ✅ market now comes from the search response
  const market = card.market ?? null;
  const [price, setPrice] = useState<number | null>(
    market != null ? clampSuggested(market) : null
  );

  // keep foil switch in sync with default toggle in header
  useEffect(() => {
    setFoil(defaultFoil);
  }, [defaultFoil]);

  const suggested = market != null ? clampSuggested(market) : null;
  const lineTotal =
    price != null && Number.isFinite(price) ? price * (qty || 0) : null;

  const canStage =
    qty > 0 &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0;

  function handleStageClick() {
    if (!canStage) return;

    const item: StagedItem = {
      key: `${card.id}-${Date.now()}`,
      blueprintId: card.id,
      name: card.name,
      setName: card.setName,
      setCode: card.setCode,
      imageUrl: card.imageUrl,
      market,
      suggested,
      price,
      quantity: qty,
      condition,
      foil,
    };

    onStage(item);

    notifications.show({
      title: "Staged",
      message: `${card.name} added to staged listings.`,
    });
  }

  return (
    <Paper withBorder radius="md" p="md">
      <Group align="flex-start" justify="space-between" wrap="nowrap">
        <Group
          align="flex-start"
          wrap="nowrap"
          style={{ flex: 1, minWidth: 0 }}
        >
          <Image
            src={card.imageUrl}
            w={62}
            h={86}
            radius="md"
            fit="contain"
            fallbackSrc="https://placehold.co/124x172?text=Card"
          />

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group
              justify="space-between"
              align="flex-start"
              wrap="nowrap"
            >
              <Box style={{ minWidth: 0 }}>
                <Text fw={700} lineClamp={1}>
                  {card.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {card.setCode
                    ? `${card.setCode} – ${card.setName ?? ""}`
                    : card.setName ?? ""}
                </Text>
              </Box>

              <Badge size="sm" variant="light">
                {card.number || "No."}
              </Badge>
            </Group>

            <Group mt="xs" gap="lg" align="center" wrap="wrap">
              <Text size="sm">
                Market{" "}
                <Text span fw={700}>
                  {money(market)}
                </Text>
              </Text>

              <Text size="sm">
                Suggested{" "}
                <Text span fw={700}>
                  {money(suggested)}
                </Text>
              </Text>

              <Text size="sm" c="dimmed">
                Line total{" "}
                <Text span fw={900}>
                  {money(lineTotal)}
                </Text>
              </Text>
            </Group>

            <Divider my="sm" />

            <Group gap="md" align="flex-end" wrap="wrap">
              <NumberInput
                label="Qty"
                value={qty}
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
                  setQty(q);
                }}
                min={1}
                step={1}
                clampBehavior="strict"
                w={90}
                radius="md"
              />

              <NumberInput
                label="Price"
                value={price ?? undefined}
                onChange={(v) => {
                  const num =
                    typeof v === "number"
                      ? v
                      : typeof v === "string"
                      ? Number(v)
                      : null;
                  setPrice(
                    num != null && Number.isFinite(num as number)
                      ? (num as number)
                      : null
                  );
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
                <Text size="sm" fw={600} mb={6}>
                  Condition
                </Text>
                <SegmentedControl
                  size="xs"
                  value={condition}
                  onChange={(v) => setCondition(v as Condition)}
                  data={[
                    { label: "NM", value: "NM" },
                    { label: "LP", value: "LP" },
                    { label: "MP", value: "MP" },
                    { label: "HP", value: "HP" },
                  ]}
                />
              </Box>

              <Box>
                <Text size="sm" fw={600} mb={6}>
                  Foil
                </Text>
                <Switch
                  checked={foil}
                  onChange={(e) => setFoil(e.currentTarget.checked)}
                />
              </Box>

              <Box style={{ flex: 1 }} />

              <Button
                radius="xl"
                leftSection={<IconShoppingCart size={16} />}
                disabled={!canStage}
                onClick={handleStageClick}
              >
                Stage
              </Button>
            </Group>
          </Box>
        </Group>
      </Group>
    </Paper>
  );
}
