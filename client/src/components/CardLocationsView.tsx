import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Box,
  Text,
  Title,
  Table,
  Loader,
  Center,
  ScrollArea,
  Group,
  Badge,
  Stack,
  Alert,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

const API_BASE = "http://localhost:3000/api";

type BinInfo =
  | string
  | {
      _id: string;
      name?: string;
      rows?: number;
      description?: string;
    };

type Location = {
  bin: BinInfo;
  row: number;
  quantity: number;
};

type InventoryItem = {
  _id: string;
  cardTraderId?: number;
  game?: string;
  setCode?: string;
  name?: string;
  condition?: string;
  isFoil?: boolean;
  price?: number;
  totalQuantity?: number;
  locations: Location[];
  notes?: string;
};

type CardLocationsViewProps = {
  itemId: string | null;
  opened: boolean;
  onClose: () => void;
};

export function CardLocationsView({
  itemId,
  opened,
  onClose,
}: CardLocationsViewProps) {
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened || !itemId) return;

    const controller = new AbortController();

    const fetchItem = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`${API_BASE}/inventory/${itemId}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch inventory item (${res.status})`);
        }

        const data: InventoryItem = await res.json();
        setItem(data);
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.error("Error fetching inventory item:", err);
        setError(err.message || "Failed to fetch inventory item");
      } finally {
        setLoading(false);
      }
    };

    fetchItem();

    return () => controller.abort();
  }, [itemId, opened]);

  const totalQuantity = useMemo(() => {
    if (!item) return 0;
    return (item.locations || []).reduce(
      (sum, loc) => sum + (loc.quantity || 0),
      0
    );
  }, [item]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      title={
        <Stack gap={2}>
          <Title order={3}>{item?.name || "Card locations"}</Title>
          <Group gap="xs">
            {item?.cardTraderId && (
              <Badge size="xs" variant="outline">
                CT #{item.cardTraderId}
              </Badge>
            )}
            {item?.game && (
              <Badge size="xs" variant="light">
                {item.game}
              </Badge>
            )}
            {item?.setCode && (
              <Badge size="xs" variant="light">
                {item.setCode}
              </Badge>
            )}
          </Group>
        </Stack>
      }
    >
      <Box>
        {loading && (
          <Center mih={160}>
            <Loader />
          </Center>
        )}

        {!loading && error && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={18} />}
            mb="md"
          >
            {error}
          </Alert>
        )}

        {!loading && !error && item && (
          <>
            <Group justify="space-between" mb="sm">
              <Text size="sm" c="dimmed">
                Showing all bins & rows where this card is stored.
              </Text>
              <Text size="sm">
                Total quantity across all locations:{" "}
                <Text component="span" fw={600}>
                  {totalQuantity}
                </Text>
              </Text>
            </Group>

            <ScrollArea.Autosize mah={340}>
              <Table
                highlightOnHover
                verticalSpacing="xs"
                striped
                withTableBorder
                withColumnBorders
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Bin</Table.Th>
                    <Table.Th>Row</Table.Th>
                    <Table.Th ta="right">Quantity</Table.Th>
                    <Table.Th>Description</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(item.locations || []).map((loc, idx) => {
                    let binName = "";
                    let binDesc = "";
                    if (typeof loc.bin === "string") {
                      binName = loc.bin;
                    } else if (loc.bin) {
                      binName = loc.bin.name || loc.bin._id;
                      binDesc = loc.bin.description || "";
                    }

                    return (
                      <Table.Tr key={idx}>
                        <Table.Td>
                          <Text fw={500}>{binName}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">Row {loc.row}</Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text fw={600}>{loc.quantity}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {binDesc}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}

                  {(!item.locations || item.locations.length === 0) && (
                    <Table.Tr>
                      <Table.Td colSpan={4}>
                        <Text c="dimmed" ta="center">
                          This card is not assigned to any bins yet.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>

            {item.notes && (
              <Box mt="md">
                <Text size="sm" fw={500}>
                  Notes
                </Text>
                <Text size="sm" c="dimmed">
                  {item.notes}
                </Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </Modal>
  );
}
