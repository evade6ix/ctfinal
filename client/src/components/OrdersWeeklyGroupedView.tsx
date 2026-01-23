import { useEffect, useState } from "react";
import {
  Accordion,
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Image,
} from "@mantine/core";

type WeeklyResponse = {
  key: string;
  from: string;
  to: string;
  label: string;
  cardmap: {
    [blueprintId: string]: {
      blueprintId: number;
      name: string;
      expansion: string;
      totalQuantity: number;
      items: {
        orderId: number | string;
        code: string;
        quantity: number;
      }[];
    };
  };
};

export function OrdersWeeklyGroupedView() {
  const [data, setData] = useState<WeeklyResponse[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch("/api/orders-weekly");
      const json = await res.json();
      setData(Array.isArray(json) ? json : []);
      setLoading(false);
    })();
  }, []);

  return (
    <Stack gap="md">
      <Title order={3}>CardTrader Zero – Weekly Shipments</Title>
      <Text size="sm" c="dimmed">
        Every Wednesday → Tuesday. All orders & all cards combined.
      </Text>

      {loading && (
        <Group justify="center" mt="xl">
          <Loader size="lg" />
        </Group>
      )}

      {!loading &&
        data.map((week) => {
          const rows = Object.values(week.cardmap).sort(
            (a, b) => b.totalQuantity - a.totalQuantity
          );

          return (
            <Paper
              key={week.key}
              p="md"
              radius="md"
              withBorder
              style={{ background: "var(--mantine-color-dark-7)" }}
            >
              {/* HEADER */}
              <Group justify="space-between" mb="sm">
                <Text fw={600} size="lg">
                  {week.label}
                </Text>
                <Badge variant="filled" color="gray">
                  {rows.length} cards
                </Badge>
              </Group>

              {/* ACCORDION */}
              <Accordion
                variant="separated"
                multiple
                styles={{
                  item: {
                    background: "var(--mantine-color-dark-6)",
                    borderRadius: 8,
                    border: "1px solid var(--mantine-color-dark-4)",
                  },
                  control: {
                    padding: "10px 14px",
                  },
                  panel: {
                    background: "var(--mantine-color-dark-7)",
                    padding: "12px 16px",
                  },
                }}
              >
                {rows.map((c) => (
                  <Accordion.Item key={c.blueprintId} value={String(c.blueprintId)}>
                    <Accordion.Control>
                      <Group gap="md">
                        <Image
                          w={40}
                          h={56}
                          fit="contain"
                          radius="sm"
                          src={`https://img.cardtrader.com/blueprints/${c.blueprintId}/front.jpg`}
                        />
                        <Stack gap={0}>
                          <Text fw={500}>{c.name}</Text>
                          <Text size="xs" c="dimmed">
                            {c.expansion}
                          </Text>
                        </Stack>
                      </Group>
                    </Accordion.Control>

                    <Accordion.Panel>
                      <Stack gap="sm">
                        <Text fw={500}>
                          Total needed:{" "}
                          <Badge color="yellow" variant="filled">
                            {c.totalQuantity}
                          </Badge>
                        </Text>

                        <Table
                          striped
                          withTableBorder
                          withColumnBorders
                          styles={{
                            table: {
                              background: "var(--mantine-color-dark-7)",
                            },
                            th: {
                              background: "var(--mantine-color-dark-6)",
                            },
                          }}
                        >
                          <Table.Thead>
                            <Table.Tr>
                              <Table.Th>Order</Table.Th>
                              <Table.Th>Quantity</Table.Th>
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {c.items.map((i, idx) => (
                              <Table.Tr key={idx}>
                                <Table.Td>{i.code}</Table.Td>
                                <Table.Td>{i.quantity}</Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            </Paper>
          );
        })}
    </Stack>
  );
}
