import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Image,
  Loader,
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
  marketCondition?: string;
  marketFoil?: boolean;
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
  condition: Condition;
  foil: boolean;
};

const PAGE_SIZE = 50;
const STAGED_STORAGE_KEY = "ct_staged_v1";

const PUSH_CONFIG: Record<PushMode, { label: string; endpoint: string; successName: string }> = {
  all: { label: "Push Live (All)", endpoint: "/api/staged-push/all", successName: "CardTrader + ManaPool" },
  manapool: { label: "ManaPool Only", endpoint: "/api/staged-push/manapool", successName: "ManaPool" },
  cardtrader: { label: "CardTrader Only", endpoint: "/api/staged-push/cardtrader", successName: "CardTrader" },
};

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function clampSuggested(market: number | null | undefined) {
  if (market == null || Number.isNaN(market)) return null;
  return Math.max(0.01, Math.round((market - 0.15) * 100) / 100);
}

function conditionToCardTrader(condition: Condition) {
  if (condition === "LP") return "Slightly Played";
  if (condition === "MP") return "Moderately Played";
  if (condition === "HP") return "Heavily Played";
  return "Near Mint";
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

  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

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
        body: JSON.stringify({
          gameId,
          setIds: selectedSetIds,
          query: query.trim() || null,
          page: targetPage,
          pageSize: PAGE_SIZE,
          condition: "Near Mint",
          foil: foilDefault,
          language: "en",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed");

      const itemsRaw = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
      const mapped: CatalogCard[] = itemsRaw.map((c: any) => ({
        id: c.id ?? `${c.setCode}-${c.name}`,
        name: c.name ?? "Unknown Card",
        setName: c.setName,
        setCode: c.setCode,
        rarity: c.rarity,
        number: c.collectorNumber ?? c.number,
        language: c.language,
        condition: c.condition,
        imageUrl: c.image_url || c.imageUrl || c.image || (Array.isArray(c.images) && c.images[0]?.url) || undefined,
        market: typeof c.market === "number" ? c.market : typeof c.marketPrice === "number" ? c.marketPrice : null,
        marketCondition: c.marketCondition,
        marketFoil: typeof c.marketFoil === "boolean" ? c.marketFoil : foilDefault,
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
      .map((s) => ({
        blueprintId: s.blueprintId,
        quantity: s.quantity,
        price: s.price,
        condition: s.condition,
        foil: s.foil,
        name: s.name,
        setCode: s.setCode,
        gameId,
      }))
      .filter((it) => Number.isFinite(Number(it.blueprintId)) && Number(it.quantity) > 0 && typeof it.price === "number" && Number.isFinite(it.price) && it.price > 0);
  }

  async function pushLive(mode: PushMode) {
    if (!staged.length) return;
    if (!destBinId || destRow == null) return alert("Select a bulk box and row for this batch before pushing live.");

    const items = buildPushItems();
    if (!items.length) return alert("All staged items need a valid price and quantity before pushing live.");

    const config = PUSH_CONFIG[mode];

    try {
      setPushingMode(mode);
      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, binId: destBinId, row: destRow, gameId }),
      });

      const data = await res.json();
      if (!res.ok) return alert(data?.error || `${config.label} failed with status ${res.status}. Check console for details.`);
      if ((data?.failed ?? 0) > 0) return alert(`Partial push to ${config.successName}: created ${data?.created ?? 0}, failed ${data?.failed ?? 0}. See console for details.`);

      alert(`Pushed ${data?.created ?? 0} staged listings live on ${config.successName}.`);
      setStaged([]);
    } catch (err: any) {
      alert(err.message || `${config.label} failed`);
    } finally {
      setPushingMode(null);
    }
  }

  function updateStagedItem(key: string, patch: Partial<StagedItem>) {
    setStaged((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  const pushDisabled = !staged.length || pushingMode != null;

  return (
    <Stack gap="md">
      <Box>
        <Title order={2}>CardTrader Catalog Search</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Choose a game, pick one or more sets, then search. This pulls <strong>CardTrader blueprints</strong>, not your local inventory.
        </Text>
      </Box>

      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm">
            <Badge leftSection={<IconShoppingCart size={14} />} variant="light" radius="sm">
              Staged: {staged.length}
            </Badge>
            <Text size="sm" c="dimmed">
              Qty: <Text span fw={700}>{stagedTotals.totalQty}</Text> • Value: <Text span fw={700}>{money(stagedTotals.totalValue)}</Text>
            </Text>
          </Group>

          <Group gap="sm">
            <Text size="xs" c="dimmed">Default foil</Text>
            <Switch size="xs" checked={foilDefault} onChange={(e) => setFoilDefault(e.currentTarget.checked)} />
            <Button size="sm" radius="xl" leftSection={<IconRocket size={14} />} disabled={pushDisabled} loading={pushingMode === "all"} onClick={() => pushLive("all")}>Push Live (All)</Button>
            <Button size="sm" radius="xl" variant="light" disabled={pushDisabled} loading={pushingMode === "manapool"} onClick={() => pushLive("manapool")}>ManaPool Only</Button>
            <Button size="sm" radius="xl" variant="light" disabled={pushDisabled} loading={pushingMode === "cardtrader"} onClick={() => pushLive("cardtrader")}>CardTrader Only</Button>
          </Group>
        </Group>
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
                  <TextInput label="Card name (optional)" placeholder="Ragavan, Nimble Pilferer" value={query} onChange={(e) => setQuery(e.currentTarget.value)} leftSection={<IconSearch size={18} />} style={{ flex: 1, minWidth: "260px" }} />
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
              {results.map((card) => <CatalogResultRow key={card.id} card={card} defaultFoil={foilDefault} onStage={(item) => setStaged((prev) => [item, ...prev])} />)}

              {totalPages > 1 && (
                <Box px="md" py="xs">
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} results</Text>
                    <Pagination value={page} onChange={(newPage) => runSearch(newPage)} total={totalPages} size="sm" />
                  </Group>
                </Box>
              )}
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="staged" pt="md">
          {!staged.length ? (
            <Alert icon={<IconAlertTriangle size={16} />} color="gray" variant="light" radius="md">
              Nothing staged yet. Use the <b>Search</b> tab and click <b>Stage</b> on cards to build a batch.
            </Alert>
          ) : (
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
                      <Box style={{ minWidth: 0 }}>
                        <Text fw={600} lineClamp={1}>{item.name}</Text>
                        <Text size="xs" c="dimmed">{item.setCode ? `${item.setCode} – ${item.setName ?? ""}` : item.setName ?? ""}</Text>
                        <Text size="xs" c="dimmed">{item.condition} • {item.foil ? "Foil" : "Non-foil"} • Market: {money(item.market)} • Suggested: {money(item.suggested)}</Text>
                      </Box>
                    </Group>

                    <NumberInput label="Qty" value={item.quantity} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : item.quantity; updateStagedItem(item.key, { quantity: Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 1 }); }} min={1} step={1} clampBehavior="strict" w={90} radius="md" />
                    <NumberInput label="Price" value={item.price ?? undefined} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null; updateStagedItem(item.key, { price: num != null && Number.isFinite(num) ? num : null }); }} min={0.01} step={0.01} decimalScale={2} fixedDecimalScale prefix="$" w={130} radius="md" />

                    <Box>
                      <Text size="xs" fw={600} mb={4}>Condition</Text>
                      <SegmentedControl size="xs" value={item.condition} onChange={(value) => updateStagedItem(item.key, { condition: value as Condition })} data={[{ label: "NM", value: "NM" }, { label: "LP", value: "LP" }, { label: "MP", value: "MP" }, { label: "HP", value: "HP" }]} />
                    </Box>

                    <Box>
                      <Text size="xs" fw={600} mb={4}>Foil</Text>
                      <Switch size="sm" checked={item.foil} onChange={(e) => updateStagedItem(item.key, { foil: e.currentTarget.checked })} />
                    </Box>

                    <Button variant="subtle" color="red" onClick={() => setStaged((prev) => prev.filter((row) => row.key !== item.key))}>Remove</Button>
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

function CatalogResultRow({ card, defaultFoil, onStage }: { card: CatalogCard; defaultFoil: boolean; onStage: (item: StagedItem) => void }) {
  const [qty, setQty] = useState(1);
  const [condition, setCondition] = useState<Condition>("NM");
  const [foil, setFoil] = useState(defaultFoil);
  const [market, setMarket] = useState<number | null>(card.market ?? null);
  const [price, setPrice] = useState<number | null>(clampSuggested(card.market));
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    setFoil(defaultFoil);
  }, [defaultFoil]);

  useEffect(() => {
    const conditionName = conditionToCardTrader(condition);
    const initialMatches = conditionName === (card.marketCondition || "Near Mint") && foil === (card.marketFoil ?? defaultFoil);

    if (initialMatches) {
      setMarket(card.market ?? null);
      setPrice(clampSuggested(card.market));
      setMarketError(null);
      return;
    }

    const controller = new AbortController();

    async function loadMarket() {
      try {
        setLoadingMarket(true);
        setMarketError(null);

        const params = new URLSearchParams({
          blueprint_id: String(card.id),
          condition: conditionName,
          foil: foil ? "true" : "false",
          language: "en",
        });

        const res = await fetch(`/api/catalog/market?${params.toString()}`, { signal: controller.signal });
        const data = await res.json();

        if (!res.ok) throw new Error(data?.error || `Market lookup failed (${res.status})`);

        const nextMarket = typeof data.market === "number" ? data.market : null;
        setMarket(nextMarket);
        setPrice(clampSuggested(nextMarket));
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        console.error("Market lookup error:", err);
        setMarket(null);
        setPrice(null);
        setMarketError(err.message || "Market lookup failed");
      } finally {
        setLoadingMarket(false);
      }
    }

    loadMarket();
    return () => controller.abort();
  }, [card.id, card.market, card.marketCondition, card.marketFoil, condition, foil, defaultFoil]);

  const suggested = clampSuggested(market);
  const lineTotal = price != null && Number.isFinite(price) ? price * (qty || 0) : null;
  const canStage = qty > 0 && typeof price === "number" && Number.isFinite(price) && price > 0 && !loadingMarket;

  function stageCard() {
    if (!canStage) return;

    onStage({
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
              <Text size="sm">Market <Text span fw={700}>{loadingMarket ? "Loading…" : money(market)}</Text></Text>
              <Text size="sm">Suggested <Text span fw={700}>{money(suggested)}</Text></Text>
              <Text size="sm" c="dimmed">Line total <Text span fw={900}>{money(lineTotal)}</Text></Text>
              <Text size="xs" c="dimmed">English • CT Zero • Pro • {conditionToCardTrader(condition)} • {foil ? "Foil" : "Non-foil"}</Text>
            </Group>

            {marketError && <Text size="xs" c="red" mt={4}>{marketError}</Text>}

            <Group gap="md" align="flex-end" wrap="wrap" mt="sm">
              <NumberInput label="Qty" value={qty} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1; setQty(Number.isFinite(num) ? Math.max(1, Math.floor(num)) : 1); }} min={1} step={1} clampBehavior="strict" w={90} radius="md" />

              <NumberInput label="Price" value={price ?? undefined} onChange={(value) => { const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null; setPrice(num != null && Number.isFinite(num) ? num : null); }} min={0.01} step={0.01} decimalScale={2} fixedDecimalScale prefix="$" w={130} radius="md" />

              <Box>
                <Text size="sm" fw={600} mb={6}>Condition</Text>
                <SegmentedControl size="xs" value={condition} onChange={(value) => setCondition(value as Condition)} data={[{ label: "NM", value: "NM" }, { label: "LP", value: "LP" }, { label: "MP", value: "MP" }, { label: "HP", value: "HP" }]} />
              </Box>

              <Box>
                <Text size="sm" fw={600} mb={6}>Foil</Text>
                <Switch checked={foil} onChange={(e) => setFoil(e.currentTarget.checked)} />
              </Box>

              <Box style={{ flex: 1 }} />
              <Button radius="xl" leftSection={<IconShoppingCart size={16} />} disabled={!canStage} onClick={stageCard}>Stage</Button>
            </Group>
          </Box>
        </Group>
      </Group>
    </Paper>
  );
}
