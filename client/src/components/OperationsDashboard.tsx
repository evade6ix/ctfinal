import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconBox,
  IconCards,
  IconCheck,
  IconClock,
  IconRefresh,
  IconRoute,
  IconShieldCheck,
} from "@tabler/icons-react";
import { MetricCard, PageHeader, StatusPill } from "./ui/OperationsUI";

type DashboardSummary = {
  generatedAt: string;
  database: { connected: boolean; state: string };
  system: { healthy: boolean; failedRuns: number };
  inventory: {
    skuCount: number;
    cardCount: number;
    inventoryValue: number;
    cardTraderListings: number;
    manaPoolListings: number;
    binCount: number;
  };
  allocations: {
    activeLines: number;
    activeCards: number;
    pickedLines: number;
    unpickedLines: number;
    exceptions: number;
    bySource: { cardtrader: number; manapool: number };
  };
  integrity: { healthy: boolean; issueCount: number };
  recentRuns: Array<{
    _id: string;
    label: string;
    status: string;
    source: string;
    startedAt: string;
    durationMs?: number;
    summary?: Record<string, unknown>;
  }>;
};

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function money(value: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function timeAgo(value: string) {
  const milliseconds = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function OperationsDashboard({ onNavigate }: { onNavigate: (section: string) => void }) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/operations/summary");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load operations overview");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load operations overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const pickProgress = data?.allocations.activeLines
    ? Math.round((data.allocations.pickedLines / data.allocations.activeLines) * 100)
    : 100;

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow="Live operations"
        title="Good morning, Game 3."
        description="Your CardTrader, ManaPool, inventory, and fulfillment work in one focused command centre. Start with the exceptions, then clear the pick route."
        actions={
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load} loading={loading}>
            Refresh overview
          </Button>
        }
      />

      {error && <Alert color="red" title="Dashboard unavailable">{error}</Alert>}

      {loading && !data ? (
        <Paper className="surface-card" p={60} radius="xl">
          <Group justify="center"><Loader /></Group>
        </Paper>
      ) : data ? (
        <>
          <Paper className="hero-status" p="xl" radius="xl">
            <Group justify="space-between" align="center" wrap="wrap" gap="xl">
              <Group gap="lg" wrap="nowrap">
                <ThemeIcon size={54} radius="xl" color={data.system.healthy ? "teal" : "yellow"} variant="light">
                  {data.system.healthy ? <IconShieldCheck size={28} /> : <IconBolt size={28} />}
                </ThemeIcon>
                <div>
                  <Group gap="sm">
                    <Title order={3}>{data.system.healthy ? "Operations are healthy" : "A few items need attention"}</Title>
                    <StatusPill ok={data.database.connected} label={`Database ${data.database.state}`} />
                  </Group>
                  <Text c="dimmed" size="sm" mt={5}>
                    {data.allocations.unpickedLines} lines remain on the pick route and {data.allocations.exceptions} require manual review.
                  </Text>
                </div>
              </Group>
              <Group>
                <Button color="yellow" c="dark.9" rightSection={<IconArrowRight size={16} />} onClick={() => onNavigate("picking")}>
                  Open pick route
                </Button>
                <Button variant="default" onClick={() => onNavigate("integrity")}>Review integrity</Button>
              </Group>
            </Group>
          </Paper>

          <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="lg">
            <MetricCard
              label="Cards waiting to pick"
              value={compactNumber(data.allocations.activeCards)}
              detail={`${data.allocations.unpickedLines} unpicked lines across both marketplaces`}
              icon={IconRoute}
              tone="gold"
              badge={`${pickProgress}% complete`}
            />
            <MetricCard
              label="Manual exceptions"
              value={compactNumber(data.allocations.exceptions)}
              detail="Order lines that could not be matched or allocated automatically"
              icon={IconAlertTriangle}
              tone={data.allocations.exceptions ? "red" : "green"}
              badge={data.allocations.exceptions ? "Needs review" : "Clear"}
            />
            <MetricCard
              label="Physical inventory"
              value={compactNumber(data.inventory.cardCount)}
              detail={`${compactNumber(data.inventory.skuCount)} SKUs organized across ${data.inventory.binCount} bins`}
              icon={IconCards}
              tone="blue"
            />
            <MetricCard
              label="Inventory value"
              value={money(data.inventory.inventoryValue)}
              detail={`${compactNumber(data.inventory.cardTraderListings)} CardTrader · ${compactNumber(data.inventory.manaPoolListings)} ManaPool listings`}
              icon={IconBox}
              tone="violet"
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 5 }} spacing="lg">
            <Paper className="surface-card dashboard-main-card" p="xl" radius="xl">
              <Group justify="space-between" mb="lg">
                <div>
                  <Text className="section-kicker">Fulfillment</Text>
                  <Title order={3}>Today’s pick progress</Title>
                </div>
                <Badge size="lg" variant="light" color={pickProgress === 100 ? "teal" : "yellow"}>
                  {pickProgress}%
                </Badge>
              </Group>
              <Progress value={pickProgress} size={14} radius="xl" color="yellow" />
              <SimpleGrid cols={3} mt="xl">
                <div>
                  <Text size="xl" fw={800}>{data.allocations.unpickedLines}</Text>
                  <Text size="xs" c="dimmed">Still to pick</Text>
                </div>
                <div>
                  <Text size="xl" fw={800}>{data.allocations.bySource.cardtrader}</Text>
                  <Text size="xs" c="dimmed">CardTrader lines</Text>
                </div>
                <div>
                  <Text size="xl" fw={800}>{data.allocations.bySource.manapool}</Text>
                  <Text size="xs" c="dimmed">ManaPool lines</Text>
                </div>
              </SimpleGrid>
              <Button mt="xl" variant="subtle" rightSection={<IconArrowRight size={15} />} onClick={() => onNavigate("picking")}>
                Continue from the next bin
              </Button>
            </Paper>

            <Paper className="surface-card dashboard-side-card" p="xl" radius="xl">
              <Text className="section-kicker">Data confidence</Text>
              <Title order={3}>Inventory integrity</Title>
              <Group mt="xl" gap="lg" align="center" wrap="nowrap">
                <ThemeIcon size={54} radius="xl" variant="light" color={data.integrity.healthy ? "teal" : "orange"}>
                  {data.integrity.healthy ? <IconCheck size={28} /> : <IconAlertTriangle size={28} />}
                </ThemeIcon>
                <div>
                  <Text size="xl" fw={800}>{data.integrity.issueCount}</Text>
                  <Text size="sm" c="dimmed">potential discrepancies detected</Text>
                </div>
              </Group>
              <Button fullWidth mt="xl" variant="default" onClick={() => onNavigate("integrity")}>
                Open integrity centre
              </Button>
            </Paper>
          </SimpleGrid>

          <Paper className="surface-card" p="xl" radius="xl">
            <Group justify="space-between" mb="md">
              <div>
                <Text className="section-kicker">Automation trail</Text>
                <Title order={3}>Recent operations</Title>
              </div>
              <Button variant="subtle" rightSection={<IconArrowRight size={15} />} onClick={() => onNavigate("operations")}>
                View complete history
              </Button>
            </Group>
            {data.recentRuns.length ? (
              <Table verticalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Operation</Table.Th>
                    <Table.Th>Source</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>When</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.recentRuns.slice(0, 5).map((run) => (
                    <Table.Tr key={run._id}>
                      <Table.Td><Text fw={650} size="sm">{run.label}</Text></Table.Td>
                      <Table.Td><Badge variant="light" color="gray">{run.source}</Badge></Table.Td>
                      <Table.Td>
                        <Badge color={run.status === "completed" ? "teal" : run.status === "failed" ? "red" : "yellow"} variant="light">
                          {run.status.replaceAll("_", " ")}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap"><IconClock size={14} /><Text size="sm" c="dimmed">{timeAgo(run.startedAt)}</Text></Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            ) : (
              <Text c="dimmed" size="sm" py="xl">New sync, repricing, listing, and batch-picking runs will appear here.</Text>
            )}
          </Paper>
        </>
      ) : null}
    </Stack>
  );
}
