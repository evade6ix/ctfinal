import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh, IconRocket, IconAlertTriangle } from "@tabler/icons-react";

type RepriceChange = {
  productId: number | string;
  blueprintId: number | string;
  name: string;
  setCode?: string;
  condition?: string;
  foil?: boolean;
  quantity?: number;
  currentPrice?: number;
  marketPrice?: number;
  targetPrice?: number;
  marketSeller?: string | null;
  ok?: boolean;
  error?: unknown;
};

type RepriceResponse = {
  ok: boolean;
  mode: "preview" | "apply";
  scanned: number;
  totalLiveProducts: number;
  activeProducts: number;
  changed: number;
  skipped: unknown[];
  attemptedUpdates?: number;
  updated?: number;
  failed?: number;
  changes: RepriceChange[];
  results?: RepriceChange[];
  error?: string;
  details?: unknown;
};

function money(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${Number(value).toFixed(2)}`;
}

export function CardTraderRepriceView() {
  const [preview, setPreview] = useState<RepriceResponse | null>(null);
  const [applyResult, setApplyResult] = useState<RepriceResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingApply, setLoadingApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [applyLimit, setApplyLimit] = useState<number | null>(null);
  const [minPriceCents, setMinPriceCents] = useState<number | null>(1);

  const shownRows = useMemo(() => {
    const source = applyResult?.results?.length ? applyResult.results : preview?.changes || [];
    return source.slice(0, 100);
  }, [preview, applyResult]);

  const progressValue = preview
    ? preview.activeProducts > 0
      ? Math.min(100, Math.round((preview.scanned / preview.activeProducts) * 100))
      : 100
    : 0;

  const skippedCount = Array.isArray(preview?.skipped) ? preview.skipped.length : 0;

  async function runPreview() {
    try {
      setLoadingPreview(true);
      setApplyResult(null);
      setError(null);

      const res = await fetch("/api/ct/reprice/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: limit || undefined,
          beatByCents: 1,
          minPriceCents: minPriceCents || 1,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Preview failed");
      setPreview(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function runApply() {
    if (!preview?.changes?.length) return;

    const yes = window.confirm(
      `This will update ${applyLimit || preview.changes.length} CardTrader price(s). This does NOT touch ManaPool. Continue?`
    );
    if (!yes) return;

    try {
      setLoadingApply(true);
      setError(null);

      const res = await fetch("/api/ct/reprice/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: limit || undefined,
          applyLimit: applyLimit || undefined,
          beatByCents: 1,
          minPriceCents: minPriceCents || 1,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Apply failed");
      setApplyResult(data);
      setPreview(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setLoadingApply(false);
    }
  }

  return (
    <Stack gap="md">
      <Box>
        <Title order={2}>CardTrader Repricing</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Preview and update CardTrader prices only. Uses English CT Zero eligible listings, matching condition and foil, then beats the cheapest eligible listing by $0.01.
        </Text>
      </Box>

      <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
        This tool does not update ManaPool. Always preview first. Marketplace lookups are processed slowly to avoid CardTrader rate limits.
      </Alert>

      <Paper withBorder radius="md" p="md">
        <Group align="flex-end" wrap="wrap">
          <NumberInput
            label="Scan limit"
            description="Blank = scan all active CT products"
            value={limit ?? undefined}
            onChange={(value) => {
              const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
              setLimit(num && Number.isFinite(num) && num > 0 ? Math.floor(num) : null);
            }}
            min={1}
            step={50}
            w={160}
          />

          <NumberInput
            label="Apply limit"
            description="Blank = apply all preview changes"
            value={applyLimit ?? undefined}
            onChange={(value) => {
              const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
              setApplyLimit(num && Number.isFinite(num) && num > 0 ? Math.floor(num) : null);
            }}
            min={1}
            step={50}
            w={160}
          />

          <NumberInput
            label="Minimum price"
            description="In cents. Default 1"
            value={minPriceCents ?? undefined}
            onChange={(value) => {
              const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
              setMinPriceCents(num && Number.isFinite(num) && num > 0 ? Math.floor(num) : 1);
            }}
            min={1}
            step={1}
            w={150}
          />

          <Button leftSection={<IconRefresh size={16} />} loading={loadingPreview} disabled={loadingApply} onClick={runPreview}>
            Preview Reprice
          </Button>

          <Button
            color="green"
            leftSection={<IconRocket size={16} />}
            loading={loadingApply}
            disabled={loadingPreview || !preview?.changes?.length}
            onClick={runApply}
          >
            Apply to CardTrader
          </Button>
        </Group>
      </Paper>

      {error && <Text c="red" size="sm">{error}</Text>}

      {(loadingPreview || loadingApply) && (
        <Paper withBorder radius="md" p="md">
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm">{loadingPreview ? "Building repricing preview…" : "Applying CardTrader price updates…"}</Text>
          </Group>
        </Paper>
      )}

      {preview && (
        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm" wrap="wrap">
            <Group gap="xs" wrap="wrap">
              <Badge variant="light">Live CT products: {preview.totalLiveProducts}</Badge>
              <Badge variant="light">Active scanned: {preview.scanned}</Badge>
              <Badge color="green" variant="light">Changes: {preview.changed}</Badge>
              <Badge color="gray" variant="light">Skipped: {skippedCount}</Badge>
              {applyResult && <Badge color="blue" variant="light">Updated: {applyResult.updated ?? 0}</Badge>}
              {applyResult && <Badge color="red" variant="light">Failed: {applyResult.failed ?? 0}</Badge>}
            </Group>
          </Group>

          <Progress value={progressValue} radius="xl" mb="sm" />

          <Text size="xs" c="dimmed" mb="md">
            Logic: English • CT Zero eligible • seller type blank/pro-compatible • same condition • same foil status • excludes your own listings • target = eligible market - $0.01.
          </Text>

          {shownRows.length === 0 ? (
            <Text size="sm" c="dimmed">No price changes needed.</Text>
          ) : (
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Card</Table.Th>
                  <Table.Th>Set</Table.Th>
                  <Table.Th>Cond</Table.Th>
                  <Table.Th>Foil</Table.Th>
                  <Table.Th>Current</Table.Th>
                  <Table.Th>Market</Table.Th>
                  <Table.Th>New</Table.Th>
                  <Table.Th>Seller</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shownRows.map((row, idx) => (
                  <Table.Tr key={`${row.productId}-${idx}`}>
                    <Table.Td><Text size="sm" fw={600}>{row.name}</Text><Text size="xs" c="dimmed">#{row.productId}</Text></Table.Td>
                    <Table.Td>{row.setCode || "—"}</Table.Td>
                    <Table.Td>{row.condition || "—"}</Table.Td>
                    <Table.Td>{row.foil ? "Foil" : "Non-foil"}</Table.Td>
                    <Table.Td>{money(row.currentPrice)}</Table.Td>
                    <Table.Td>{money(row.marketPrice)}</Table.Td>
                    <Table.Td><Text fw={700}>{money(row.targetPrice)}</Text></Table.Td>
                    <Table.Td>{row.marketSeller || "—"}</Table.Td>
                    <Table.Td>{applyResult ? (row.ok === false ? "Failed" : "Updated") : "Preview"}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}

          {shownRows.length >= 100 && (
            <Text size="xs" c="dimmed" mt="sm">Showing first 100 rows only.</Text>
          )}
        </Paper>
      )}
    </Stack>
  );
}
