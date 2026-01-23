import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

type WeeklyCardRow = {
  key: string;
  name: string;
  expansion: string;
  condition?: string | null;
  foil?: boolean;
  totalQuantity: number;
  totalCents: number;
  currency: string;
};

type WeekBucket = {
  key: string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  label: string;
  totalCards: number;
  totalOrders: number;
  rows: WeeklyCardRow[];
};

export function OrdersWeeklyView() {
  const [buckets, setBuckets] = useState<WeekBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxWeeks, setMaxWeeks] = useState("8");

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch("/api/orders/weekly-zero");
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(
            `Failed to load weekly orders (${res.status}): ${
              txt || "Unknown error"
            }`
          );
        }

        const data = (await res.json()) as WeekBucket[];
        setBuckets(Array.isArray(data) ? data : []);
      } catch (err: any) {
        console.error(err);
        setError(err.message || "Failed to load weekly orders");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const max = parseInt(maxWeeks || "8", 10);
  const visibleBuckets = buckets.slice(0, max);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Title order={3}>CardTrader Zero – Weekly Cards</Title>
          <Text size="sm" c="dimmed">
            Every Wednesday → Tuesday, grouped by card (all CT0 orders combined).
          </Text>
        </Box>
        <Select
          label="Show"
          value={maxWeeks}
          onChange={(v) => v && setMaxWeeks(v)}
          data={[
            { value: "4", label: "Last 4 weeks" },
            { value: "8", label: "Last 8 weeks" },
            { value: "12", label: "Last 12 weeks" },
            { value: "52", label: "Last 52 weeks" },
          ]}
          maw={160}
        />
      </Group>

      {loading && (
        <Group justify="center" mt="md">
          <Loader size="sm" />
        </Group>
      )}

      {error && (
        <Alert
          color="red"
          icon={<IconAlertTriangle size={16} />}
          variant="light"
        >
          {error}
        </Alert>
      )}

      {!loading && !error && visibleBuckets.length === 0 && (
        <Text size="sm" c="dimmed">
          No CardTrader Zero orders found in this time window.
        </Text>
      )}

      {visibleBuckets.map((bucket) => (
        <Paper key={bucket.key} withBorder radius="md" p="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <Title order={4}>{bucket.label}</Title>
              <Badge variant="light" size="sm">
                {bucket.totalCards} cards
              </Badge>
              <Badge variant="outline" size="sm">
                {bucket.totalOrders} orders
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {bucket.from} → {bucket.to}
            </Text>
          </Group>

          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Card</Table.Th>
                <Table.Th>Expansion</Table.Th>
                <Table.Th>Condition</Table.Th>
                <Table.Th>Foil</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {bucket.rows.map((row) => (
                <Table.Tr key={row.key}>
                  <Table.Td>{row.name}</Table.Td>
                  <Table.Td>{row.expansion}</Table.Td>
                  <Table.Td>{row.condition || "—"}</Table.Td>
                  <Table.Td>{row.foil ? "Foil" : "Non-foil"}</Table.Td>
                  <Table.Td ta="right">{row.totalQuantity}</Table.Td>
                  <Table.Td ta="right">
                    {(row.totalCents / 100).toFixed(2)} {row.currency}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      ))}
    </Stack>
  );
}
