import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Image,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Pagination,
  Paper,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconRocket, IconSearch, IconShoppingCart } from "@tabler/icons-react";

type Option = { value: string; label: string; code?: string; cached?: boolean };
type Condition = "NM" | "LP" | "MP" | "HP";
type PushMode = "all" | "manapool" | "cardtrader";
type ConditionPrices = Record<Condition, number | null>;

type CatalogCard = {
  id: number | string;
  gameId?: number | string;
  name: string;
  setName?: string;
  setCode?: string;
  rarity?: string;
  number?: string;
  imageUrl?: string;
  market?: number | null;
};

type StagedItem = {
  key: string;
  blueprintId: number | string;
  gameId?: number | string;
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
const MTG_GAME_IDS = new Set(["1"]);

const CONDITION_OPTIONS: { value: Condition; label: string; marketCondition: string }[] = [
  { value: "NM", label: "NM", marketCondition: "Near Mint" },
  { value: "LP", label: "LP", marketCondition: "Slightly Played" },
  { value: "MP", label: "MP", marketCondition: "Moderately Played" },
  { value: "HP", label: "HP", marketCondition: "Heavily Played" },
];

const EMPTY_CONDITION_PRICES: ConditionPrices = {
  NM: null,
  LP: null,
  MP: null,
  HP: null,
};

const PUSH_CONFIG: Record<PushMode, { label: string; endpoint: string; successName: string }> = {
  all: { label: "Push Live (All)", endpoint: "/api/staged-push/all", successName: "CardTrader + ManaPool" },
  manapool: { label: "ManaPool Only", endpoint: "/api/staged-push/manapool", successName: "ManaPool" },
  cardtrader: { label: "CardTrader Only", endpoint: "/api/staged-push/cardtrader", successName: "CardTrader" },
};

function isMagicGame(game: string | number | null | undefined) {
  const normalized = String(game || "").trim().toLowerCase();
  return MTG_GAME_IDS.has(normalized) || normalized === "magic" || normalized === "mtg";
}

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function clampSuggested(market: number | null | undefined) {
  if (market == null || Number.isNaN(market)) return null;
  return Math.max(0.01, Math.round((market - 0.15) * 100) / 100);
}

function numberOrNull(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function CatalogSearchView() {
  const [games, setGames] = useState<Option[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);
  const [sets, setSets] = useState<Option[]>([]);
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
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [pushingMode, setPushingMode] = useState<PushMode | null>(null);
  const [foilDefault, setFoilDefault] = useState(false);
  const [bins, setBins] = useState<Option[]>([]);
  const [loadingBins, setLoadingBins] = useState(false);
  const [binError, setBinError] = useState<string | null>(null);
  const [destBinId, setDestBinId] = useState<string | null>(null);
  const [destRow, setDestRow] = useState<number | null>(null);
  const [pendingPushMode, setPendingPushMode] = useState<PushMode | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STAGED_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items)) setStaged(parsed.items);
      if (typeof parsed.foilDefault === "boolean") setFoilDefault(parsed.foilDefault);
    } catch (err) {
      console.error("Failed to hydrate staged", err);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STAGED_STORAGE_KEY, JSON.stringify({ items: staged, foilDefault }));
    } catch (err) {
      console.error("Failed to persist staged", err);
    }
  }, [staged, foilDefault]);

  useEffect(() => {
    async function loadGames() {
      try {
        setLoadingGames(true);
        const res = await fetch("/api/catalog/games");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load games");
        const arr = Array.isArray(data) ? data : Array.isArray(data.games) ? data.games : [];
        const mapped = arr.map((g: any) => ({ value: String(g.id), label: String(g.displayName || g.name || "Unknown Game") }));
        setGames(mapped);
        if (mapped.length) setGameId(mapped[0].value);
      } catch (err: any) {
        setError(err.message || "Failed to load games");
      } finally {
        setLoadingGames(false);
      }
    }
    loadGames();
  }, []);

  useEffect(() => {
    if (!gameId) {
      setSets([]);
      setSelectedSetIds([]);
      return;
    }
    async function loadSets(selectedGameId: string) {
      try {
        setLoadingSets(true);
        const res = await fetch(`/api/catalog/sets?gameId=${encodeURIComponent(selectedGameId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load sets");
        const arr = Array.isArray(data) ? data : Array.isArray(data.sets) ? data.sets : [];
        setSets(arr.map((s: any) => ({ value: String(s.id), label: s.code ? `${s.code} – ${s.name}` : String(s.name || "Unknown"), code: s.code, cached: !!s.cached })));
        setSelectedSetIds([]);
      } catch (err: any) {
        setError(err.message || "Failed to load sets");
      } finally {
        setLoadingSets(false);
      }
    }
    loadSets(gameId);
  }, [gameId]);

  useEffect(() => {
    async function loadBins() {
      try {
        setLoadingBins(true);
        setBinError(null);
        const res = await fetch("/api/bins");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load bins");
        setBins((Array.isArray(data) ? data : []).map((b: any) => ({ value: String(b._id), label: b.label || b.name || `Bin ${String(b._id).slice(-4)}` })));
      } catch (err: any) {
        setBinError(err.message || "Failed to load bins");
      } finally {
        setLoadingBins(false);
      }
    }
    loadBins();
  }, []);

  const stagedTotals = useMemo(() => {
    const totalQty = staged.reduce((sum, s) => sum + (s.quantity || 0), 0);
    const totalValue = staged.reduce((sum, s) => sum + (s.quantity || 0) * (s.price || 0), 0);
    return { totalQty, totalValue };
  }, [staged]);

  const stagedHasNonMagic = useMemo(
    () => staged.some((s) => {
      const stagedGameId = s.gameId || gameId;
      return !!stagedGameId && !isMagicGame(stagedGameId);
    }),
    [staged, gameId]
  );

  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const pushDisabled = !staged.length || pushingMode != null;

  async function runSearch(targetPage = page) {
    if (!gameId) return setError("Please choose a game first.");
    if (!selectedSetIds.length) return setError("Please choose at least one set.");
    try {
      setLoadingSearch(true);
      setError(null);
      setHasSearched(true);
      const res = await fetch("/api/catalog/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, setIds: selectedSetIds, query: query.trim() || null, page: targetPage, pageSize: PAGE_SIZE, condition: "Near Mint", foil: foilDefault, language: "en" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed");
      const itemsRaw = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
      const mapped: CatalogCard[] = itemsRaw.map((c: any) => ({
        id: c.id ?? `${c.setCode}-${c.name}`,
        gameId: c.gameId ?? gameId,
        name: c.name ?? "Unknown Card",
        setName: c.setName,
        setCode: c.setCode,
        rarity: c.rarity,
        number: c.collectorNumber ?? c.number,
        imageUrl: c.image_url || c.imageUrl || c.image || (Array.isArray(c.images) && c.images[0]?.url) || undefined,
        market: typeof c.market === "number" ? c.market : typeof c.marketPrice === "number" ? c.marketPrice : null,
      }));
      setResults(mapped);
      setTotal(typeof data.total === "number" ? data.total : mapped.length);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || "Failed to search catalog");
      setResults([]);
      setTotal(0);
    } finally {
      setLoadingSearch(false);
    }
  }

  function buildPushItems() {
    return staged
      .map((s) => {
        const itemGameId = s.gameId || gameId;
        return { blueprintId: s.blueprintId, quantity: s.quantity, price: s.price, condition: s.condition, foil: s.foil, name: s.name, setCode: s.setCode, gameId: itemGameId, game: itemGameId };
      })
      .filter((it) => Number.isFinite(Number(it.blueprintId)) && Number(it.quantity) > 0 && typeof it.price === "number" && Number.isFinite(it.price) && it.price > 0);
  }

  function requestPush(mode: PushMode) {
    if (!staged.length) return;
    if (!destBinId || destRow == null) {
      notifications.show({ color: "orange", title: "Destination required", message: "Select a bulk box and row for this batch before pushing live." });
      return;
    }
    if (mode !== "cardtrader" && stagedHasNonMagic) {
      notifications.show({ color: "orange", title: "CardTrader only", message: "ManaPool is Magic-only. Push Riftbound and other games to CardTrader Only." });
      return;
    }
    const items = buildPushItems();
    if (!items.length) {
      notifications.show({ color: "orange", title: "Incomplete batch", message: "Every staged item needs a valid price and quantity." });
      return;
    }
    setPendingPushMode(mode);
  }

  async function pushLive(mode: PushMode) {
    const items = buildPushItems();
    const config = PUSH_CONFIG[mode];
    try {
      setPushingMode(mode);
      setPendingPushMode(null);
      const initiatedBy = window.localStorage.getItem("ctfinal_staff_name") || "local";
      const res = await fetch(config.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, binId: destBinId, row: destRow, gameId, initiatedBy }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `${config.label} failed with status ${res.status}.`);
      if ((data?.failed ?? 0) > 0 || (data?.warnings ?? 0) > 0) {
        notifications.show({ color: "orange", title: "Batch completed with exceptions", message: `Created ${data?.created ?? 0}, failed ${data?.failed ?? 0}, warnings ${data?.warnings ?? 0}. Review Operation History for details.` });
        return;
      }
      notifications.show({ color: "teal", title: "Listings are live", message: `Pushed ${data?.created ?? 0} listings to ${config.successName}.` });
      setStaged([]);
    } catch (err: any) {
      notifications.show({ color: "red", title: `${config.label} failed`, message: err.message || "The marketplace request failed." });
    } finally {
      setPushingMode(null);
    }
  }

  function updateStagedItem(key: string, patch: Partial<StagedItem>) {
    setStaged((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function addStagedItem(item: StagedItem) {
    setStaged((prev) => [item, ...prev]);
  }

  return (
    <Stack gap="md">
      <Box>
        <Title order={2}>CardTrader Catalog Search</Title>
        <Text c="dimmed" size="sm" mt={4}>Choose a game, pick one or more sets, then search. This pulls <strong>CardTrader blueprints</strong>, not your local inventory.</Text>
      </Box>

      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm">
            <Badge leftSection={<IconShoppingCart size={14} />} variant="light" radius="sm">Staged: {staged.length}</Badge>
            <Text size="sm" c="dimmed">Qty: <Text span fw={700}>{stagedTotals.totalQty}</Text> • Value: <Text span fw={700}>{money(stagedTotals.totalValue)}</Text></Text>
            {stagedHasNonMagic && <Badge color="blue" variant="light" radius="sm">CardTrader only</Badge>}
          </Group>
          <Group gap="sm">
            <Text size="xs" c="dimmed">Default foil</Text>
            <Switch size="xs" checked={foilDefault} onChange={(e) => setFoilDefault(e.currentTarget.checked)} />
            {!stagedHasNonMagic && <Button size="sm" radius="xl" leftSection={<IconRocket size={14} />} disabled={pushDisabled} loading={pushingMode === "all"} onClick={() => requestPush("all")}>Push Live (All)</Button>}
            {!stagedHasNonMagic && <Button size="sm" radius="xl" variant="light" disabled={pushDisabled} loading={pushingMode === "manapool"} onClick={() => requestPush("manapool")}>ManaPool Only</Button>}
            <Button size="sm" radius="xl" variant="light" disabled={pushDisabled} loading={pushingMode === "cardtrader"} onClick={() => requestPush("cardtrader")}>CardTrader Only</Button>
          </Group>
        </Group>
        {stagedHasNonMagic && <Text size="xs" c="dimmed" mt="xs">ManaPool is Magic-only. Riftbound and other non-MTG games will only be pushed to CardTrader.</Text>}
      </Paper>

      <Tabs defaultValue="search" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="search">Search</Tabs.Tab>
          <Tabs.Tab value="staged">Staged ({staged.length})</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="search" pt="md">
          <Paper withBorder p="md" radius="md">
            <form onSubmit={(e) => { e.preventDefault(); runSearch(1); }}>
              <Stack gap="sm">
                <Group grow wrap="wrap">
                  <Select label="Game" placeholder={loadingGames ? "Loading games..." : "Select a game"} data={games} value={gameId} onChange={(value) => { setGameId(value); setPage(1); }} disabled={loadingGames} searchable nothingFoundMessage="No games" />
                  <MultiSelect label="Sets" placeholder={!gameId ? "Select a game first" : loadingSets ? "Loading sets..." : "Select one or more sets"} data={sets} value={selectedSetIds} onChange={(values) => { setSelectedSetIds(values); setPage(1); }} searchable disabled={!gameId || loadingSets} nothingFoundMessage={gameId ? "No sets for this game" : "Select a game first"} />
                </Group>
                <Group align="flex-end" gap="sm" wrap="wrap">
                  <TextInput label="Card name (optional)" placeholder="Search card name" value={query} onChange={(e) => setQuery(e.currentTarget.value)} leftSection={<IconSearch size={18} />} style={{ flex: 1, minWidth: "260px" }} />
                  <Button type="submit" disabled={!gameId || !selectedSetIds.length || loadingSearch} leftSection={!loadingSearch ? <IconSearch size={18} /> : undefined}>{loadingSearch ? <Loader size="xs" /> : "Search"}</Button>
                </Group>
              </Stack>
            </form>
          </Paper>

          {error && <Text c="red" size="sm" mt="sm">{error}</Text>}
          {!loadingSearch && hasSearched && !results.length && !error && <Text c="dimmed" size="sm" mt="sm">No results found for this combination.</Text>}
          {loadingSearch && <Group justify="center" mt="md"><Loader /></Group>}

          {!loadingSearch && !!results.length && (
            <Stack gap="sm" mt="md">
              {results.map((card) => (
                <CatalogResultRow key={card.id} card={card} defaultFoil={foilDefault} onStage={addStagedItem} />
              ))}
              {totalPages > 1 && <Group justify="space-between"><Text size="xs" c="dimmed">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</Text><Pagination value={page} onChange={(newPage) => runSearch(newPage)} total={totalPages} size="sm" /></Group>}
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="staged" pt="md">
          {!staged.length ? <Alert icon={<IconAlertTriangle size={16} />} color="gray" variant="light" radius="md">Nothing staged yet. Use the <b>Search</b> tab and click <b>Stage</b> on cards to build a batch.</Alert> : (
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="sm" align="flex-end">
                <Box>
                  <Title order={4}>Staged listings</Title>
                  <Text size="xs" c="dimmed">Adjust quantity, price, condition, and foil before pushing live. Then choose a bulk box + row for this batch.</Text>
                  {binError && <Text size="xs" c="red">{binError}</Text>}
                </Box>
                <Group gap="xs" align="flex-end">
                  <Select label="Bulk box" placeholder={loadingBins ? "Loading bins..." : "Select destination bin"} data={bins} value={destBinId} onChange={(value) => setDestBinId(value)} searchable clearable disabled={loadingBins} nothingFoundMessage={loadingBins ? "Loading..." : "No bins configured"} w={180} />
                  <NumberInput label="Row" value={destRow ?? undefined} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null; setDestRow(num != null && Number.isFinite(num) && num > 0 ? Math.floor(num) : null); }} min={1} step={1} clampBehavior="strict" w={80} />
                </Group>
              </Group>
              <Stack gap="sm">
                {staged.map((item) => (
                  <Group key={item.key} align="flex-start" wrap="wrap" gap="md">
                    <Group gap="sm" style={{ minWidth: 0, flex: 1 }}>
                      <Image src={item.imageUrl} w={48} h={64} fit="contain" radius="sm" fallbackSrc="https://placehold.co/96x128?text=Card" />
                      <Box style={{ minWidth: 0 }}><Text fw={600} lineClamp={1}>{item.name}</Text><Text size="xs" c="dimmed">{item.setCode ? `${item.setCode} – ${item.setName ?? ""}` : item.setName ?? ""}</Text><Text size="xs" c="dimmed">{item.condition} • {item.foil ? "Foil" : "Non-foil"} • Market: {money(item.market)} • Suggested: {money(item.suggested)}</Text></Box>
                    </Group>
                    <NumberInput label="Qty" value={item.quantity} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : item.quantity; updateStagedItem(item.key, { quantity: Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 1 }); }} min={1} step={1} clampBehavior="strict" w={90} radius="md" />
                    <NumberInput label="Price" value={item.price ?? undefined} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null; updateStagedItem(item.key, { price: num != null && Number.isFinite(num) ? num : null }); }} min={0.01} step={0.01} decimalScale={2} fixedDecimalScale prefix="$" w={130} radius="md" />
                    <Box><Text size="xs" fw={600} mb={4}>Condition</Text><SegmentedControl size="xs" value={item.condition} onChange={(value) => updateStagedItem(item.key, { condition: value as Condition })} data={CONDITION_OPTIONS.map(({ label, value }) => ({ label, value }))} /></Box>
                    <Box><Text size="xs" fw={600} mb={4}>Foil</Text><Switch size="sm" checked={item.foil} onChange={(e) => updateStagedItem(item.key, { foil: e.currentTarget.checked })} /></Box>
                    <Button variant="subtle" color="red" onClick={() => setStaged((prev) => prev.filter((row) => row.key !== item.key))}>Remove</Button>
                  </Group>
                ))}
              </Stack>
            </Paper>
          )}
        </Tabs.Panel>
      </Tabs>
      <Modal
        opened={pendingPushMode != null}
        onClose={() => setPendingPushMode(null)}
        title="Review marketplace push"
        centered
        radius="lg"
      >
        <Stack>
          <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
            This action creates live marketplace listings and adds the cards to local inventory.
          </Alert>
          <Group justify="space-between"><Text size="sm" c="dimmed">Destination</Text><Text size="sm" fw={700}>{bins.find((bin) => bin.value === destBinId)?.label || "Selected bin"} · Row {destRow}</Text></Group>
          <Group justify="space-between"><Text size="sm" c="dimmed">Listings</Text><Text size="sm" fw={700}>{staged.length}</Text></Group>
          <Group justify="space-between"><Text size="sm" c="dimmed">Physical cards</Text><Text size="sm" fw={700}>{stagedTotals.totalQty}</Text></Group>
          <Group justify="space-between"><Text size="sm" c="dimmed">Inventory value</Text><Text size="sm" fw={700}>{money(stagedTotals.totalValue)}</Text></Group>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setPendingPushMode(null)}>Cancel</Button>
            <Button color="yellow" c="dark.9" leftSection={<IconRocket size={16} />} onClick={() => pendingPushMode && pushLive(pendingPushMode)}>
              Confirm {pendingPushMode ? PUSH_CONFIG[pendingPushMode].label : "push"}
            </Button>
          </Group>
        </Stack>
      </Modal>
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
  const market = card.market ?? null;
  const [conditionPrices, setConditionPrices] = useState<ConditionPrices>({ ...EMPTY_CONDITION_PRICES, NM: market });
  const [loadingConditionPrices, setLoadingConditionPrices] = useState(false);
  const [conditionPriceError, setConditionPriceError] = useState<string | null>(null);
  const [manualPriceTouched, setManualPriceTouched] = useState(false);
  const selectedMarket = conditionPrices[condition] ?? (condition === "NM" ? market : null);
  const suggested = clampSuggested(selectedMarket);
  const [price, setPrice] = useState<number | null>(suggested);

  useEffect(() => {
    setFoil(defaultFoil);
    setManualPriceTouched(false);
  }, [defaultFoil]);

  useEffect(() => {
    let cancelled = false;

    async function loadConditionPrices() {
      const startingPrices: ConditionPrices = { ...EMPTY_CONDITION_PRICES, NM: market };
      setConditionPrices(startingPrices);
      setLoadingConditionPrices(true);
      setConditionPriceError(null);

      try {
        const entries = await Promise.all(
          CONDITION_OPTIONS.map(async (option) => {
            const params = new URLSearchParams({
              blueprint_id: String(card.id),
              condition: option.marketCondition,
              foil: String(foil),
              language: "en",
            });

            try {
              const res = await fetch(`/api/catalog/market?${params.toString()}`);
              const data = await res.json();
              if (!res.ok) throw new Error(data?.error || "Market lookup failed");
              return [option.value, numberOrNull(data?.market)] as const;
            } catch (err) {
              console.error(`Failed to load ${option.value} market for ${card.name}`, err);
              return [option.value, null] as const;
            }
          })
        );

        if (cancelled) return;
        const nextPrices: ConditionPrices = { ...EMPTY_CONDITION_PRICES };
        entries.forEach(([key, value]) => {
          nextPrices[key] = value;
        });
        if (nextPrices.NM == null) nextPrices.NM = market;
        setConditionPrices(nextPrices);
      } catch (err: any) {
        if (!cancelled) setConditionPriceError(err.message || "Failed to load condition prices");
      } finally {
        if (!cancelled) setLoadingConditionPrices(false);
      }
    }

    loadConditionPrices();

    return () => {
      cancelled = true;
    };
  }, [card.id, card.name, foil, market]);

  useEffect(() => {
    if (!manualPriceTouched) setPrice(suggested);
  }, [manualPriceTouched, suggested]);

  const lineTotal = price != null && Number.isFinite(price) ? price * (qty || 0) : null;
  const canStage = qty > 0 && typeof price === "number" && Number.isFinite(price) && price > 0;

  function handleConditionChange(value: string) {
    setCondition(value as Condition);
    setManualPriceTouched(false);
  }

  function handleStageClick() {
    if (!canStage) return;

    onStage({
      key: `${card.id}-${Date.now()}`,
      blueprintId: card.id,
      gameId: card.gameId,
      name: card.name,
      setName: card.setName,
      setCode: card.setCode,
      imageUrl: card.imageUrl,
      market: selectedMarket,
      suggested,
      price,
      quantity: qty,
      condition,
      foil,
    });

    notifications.show({ title: "Staged", message: `${card.name} added to staged listings.` });
  }

  return (
    <Paper withBorder radius="md" p="md">
      <Group align="flex-start" justify="space-between" wrap="nowrap">
        <Group align="flex-start" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <Image src={card.imageUrl} w={62} h={86} radius="md" fit="contain" fallbackSrc="https://placehold.co/124x172?text=Card" />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Box style={{ minWidth: 0 }}>
                <Text fw={700} lineClamp={1}>{card.name}</Text>
                <Text size="xs" c="dimmed">{card.setCode ? `${card.setCode} – ${card.setName ?? ""}` : card.setName ?? ""}</Text>
                <Text size="xs" c="dimmed">{card.rarity ? `Rarity: ${card.rarity}` : "Rarity: —"}</Text>
              </Box>
              <Badge size="sm" variant="light">{card.number || "No."}</Badge>
            </Group>

            <Group mt="xs" gap="lg" align="center" wrap="wrap">
              <Text size="sm">Selected market <Text span fw={700}>{money(selectedMarket)}</Text></Text>
              <Text size="sm">Suggested <Text span fw={700}>{money(suggested)}</Text></Text>
              <Text size="sm" c="dimmed">Line total <Text span fw={900}>{money(lineTotal)}</Text></Text>
            </Group>

            <Group mt="xs" gap="xs" align="center" wrap="wrap">
              <Text size="xs" fw={600}>CT Zero / Pro {foil ? "foil" : "non-foil"} prices:</Text>
              {CONDITION_OPTIONS.map((option) => (
                <Badge key={option.value} size="sm" variant={option.value === condition ? "filled" : "light"} radius="sm">
                  {option.label}: {loadingConditionPrices && conditionPrices[option.value] == null ? "..." : money(conditionPrices[option.value])}
                </Badge>
              ))}
            </Group>
            {conditionPriceError && <Text size="xs" c="red" mt={4}>{conditionPriceError}</Text>}

            <Divider my="sm" />

            <Group gap="md" align="flex-end" wrap="wrap">
              <NumberInput
                label="Qty"
                value={qty}
                onChange={(value) => {
                  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
                  setQty(Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 1);
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
                onChange={(value) => {
                  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
                  setManualPriceTouched(true);
                  setPrice(num != null && Number.isFinite(num) ? num : null);
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
                <Text size="sm" fw={600} mb={6}>Condition</Text>
                <SegmentedControl size="xs" value={condition} onChange={handleConditionChange} data={CONDITION_OPTIONS.map(({ label, value }) => ({ label, value }))} />
              </Box>

              <Box>
                <Text size="sm" fw={600} mb={6}>Foil</Text>
                <Switch checked={foil} onChange={(e) => { setFoil(e.currentTarget.checked); setManualPriceTouched(false); }} />
              </Box>

              <Box style={{ flex: 1 }} />

              <Button radius="xl" leftSection={<IconShoppingCart size={16} />} disabled={!canStage} onClick={handleStageClick}>Stage</Button>
            </Group>
          </Box>
        </Group>
      </Group>
    </Paper>
  );
}
