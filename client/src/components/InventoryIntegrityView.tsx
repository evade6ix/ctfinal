import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Paper, SimpleGrid, Stack, Table, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconDatabaseSearch, IconRefresh, IconRoute, IconShoppingCartX } from "@tabler/icons-react";
import { MetricCard, PageHeader } from "./ui/OperationsUI";

type IntegrityPayload = {
  checkedAt: string;
  healthy: boolean;
  issueCount: number;
  quantityMismatches: {
    count: number;
    items: Array<{
      _id: string;
      name: string;
      setCode?: string;
      condition?: string;
      isFoil?: boolean;
      totalQuantity: number;
      locationQuantity: number;
    }>;
  };
  missingLocations: number;
  marketplaceErrors: number;
  invalidLocations: number;
  duplicateOrderLines: number;
};

export function InventoryIntegrityView() {
  const [data, setData] = useState<IntegrityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/operations/integrity");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Integrity scan failed");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Integrity scan failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { scan(); }, [scan]);

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow="Inventory confidence"
        title="Integrity centre"
        description="A read-only audit across MongoDB totals, physical bin quantities, marketplace synchronization, and order allocation records. Running this scan never changes inventory."
        actions={<Button leftSection={<IconRefresh size={16} />} onClick={scan} loading={loading}>Run fresh scan</Button>}
      />

      {error && <Alert color="red" title="Scan unavailable">{error}</Alert>}
      {loading && !data ? <Group justify="center" py={80}><Loader /></Group> : null}

      {data && (
        <>
          <Paper className={`integrity-hero ${data.healthy ? "integrity-hero--healthy" : ""}`} p="xl" radius="xl">
            <Group gap="lg" wrap="nowrap">
              <ThemeIcon size={58} radius="xl" color={data.healthy ? "teal" : "orange"} variant="light">
                {data.healthy ? <IconCheck size={30} /> : <IconAlertTriangle size={30} />}
              </ThemeIcon>
              <div>
                <Text fw={850} size="xl">{data.healthy ? "Inventory records agree" : `${data.issueCount} potential issues detected`}</Text>
                <Text c="dimmed" size="sm" mt={5}>Last scanned {new Date(data.checkedAt).toLocaleString("en-CA")}. Review the affected records before performing any repair.</Text>
              </div>
            </Group>
          </Paper>

          <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }}>
            <MetricCard label="Quantity mismatches" value={data.quantityMismatches.count} detail="Mongo total does not equal the sum of bin and row quantities" icon={IconDatabaseSearch} tone={data.quantityMismatches.count ? "red" : "green"} />
            <MetricCard label="Missing locations" value={data.missingLocations} detail="Cards have available quantity but no physical bin location" icon={IconRoute} tone={data.missingLocations ? "gold" : "green"} />
            <MetricCard label="Marketplace errors" value={data.marketplaceErrors} detail="ManaPool synchronization returned an unresolved error" icon={IconShoppingCartX} tone={data.marketplaceErrors ? "red" : "green"} />
            <MetricCard label="Allocation conflicts" value={data.duplicateOrderLines + data.invalidLocations} detail="Duplicate order-line keys or invalid physical location values" icon={IconAlertTriangle} tone={data.duplicateOrderLines + data.invalidLocations ? "red" : "green"} />
          </SimpleGrid>

          <Paper className="surface-card" p="xl" radius="xl">
            <Group justify="space-between" mb="lg">
              <div>
                <Text className="section-kicker">Difference report</Text>
                <Text fw={850} size="lg">Mongo totals versus physical locations</Text>
              </div>
              <Badge variant="light" color={data.quantityMismatches.count ? "orange" : "teal"}>{data.quantityMismatches.count} records</Badge>
            </Group>
            {data.quantityMismatches.items.length ? (
              <Table verticalSpacing="md" highlightOnHover>
                <Table.Thead><Table.Tr><Table.Th>Card</Table.Th><Table.Th>Details</Table.Th><Table.Th>Mongo total</Table.Th><Table.Th>Location sum</Table.Th><Table.Th>Difference</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {data.quantityMismatches.items.map((item) => (
                    <Table.Tr key={item._id}>
                      <Table.Td><Text fw={700} size="sm">{item.name}</Text></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{item.setCode || "—"} · {item.condition || "—"}{item.isFoil ? " · Foil" : ""}</Text></Table.Td>
                      <Table.Td>{item.totalQuantity}</Table.Td>
                      <Table.Td>{item.locationQuantity}</Table.Td>
                      <Table.Td><Badge color="orange" variant="light">{item.totalQuantity - item.locationQuantity > 0 ? "+" : ""}{item.totalQuantity - item.locationQuantity}</Badge></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            ) : (
              <Text c="dimmed" size="sm" py="xl">No quantity mismatches were found.</Text>
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}
