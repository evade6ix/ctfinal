import { useEffect, useMemo, useState } from "react";
import {
  Drawer,
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
import { CardLocationsView } from "./CardLocationsView";

type Location = {
  bin: string | { _id: string; name?: string; rows?: number };
  row: number;
  quantity: number;
};

type BinItem = {
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

type BinDetailViewProps = {
  binId: string | null;
  binName?: string;
  opened: boolean;
  onClose: () => void;
};

export function BinDetailView({
  binId,
  binName,
  opened,
  onClose,
}: BinDetailViewProps) {
  const [items, setItems] = useState<BinItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NEW: state for "see all locations for this card"
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [locationsOpened, setLocationsOpened] = useState(false);

  const handleOpenLocations = (itemId: string) => {
    setSelectedItemId(itemId);
    setLocationsOpened(true);
  };

  const handleCloseLocations = () => {
    setLocationsOpened(false);
    // optional: clear selection
    // setSelectedItemId(null);
  };

  // Fetch items when the drawer opens and binId changes
  useEffect(() => {
    if (!opened || !binId) {
      return;
    }

    const controller = new AbortController();
    const fetchItems = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`/api/bins/${binId}/items`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch bin items (${res.status})`);
        }

        const data: BinItem[] = await res.json();
        setItems(data);
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.error("Error fetching bin items:", err);
        setError(err.message || "Failed to fetch bin items");
      } finally {
        setLoading(false);
      }
    };

    fetchItems();

    return () => {
      controller.abort();
    };
  }, [binId, opened]);

  // Compute total quantity in THIS bin per item (sum of locations.quantity for this bin)
  const rows = useMemo(() => {
    return items.map((item) => {
      const qtyInBin = (item.locations || []).reduce(
        (sum, loc) => sum + (loc.quantity || 0),
        0
      );

      const rowBreakdown = (item.locations || [])
        .map((loc) => `Row ${loc.row}: ${loc.quantity}`)
        .join("  •  ");

      return {
        ...item,
        qtyInBin,
        rowBreakdown,
      };
    });
  }, [items]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        <Stack gap={2}>
          <Title order={3}>Bin: {binName || binId || "Unknown bin"}</Title>
          <Text size="sm" c="dimmed">
            Showing all inventory items currently stored in this bin.
          </Text>
        </Stack>
      }
    >
      <Box h="100%" style={{ display: "flex", flexDirection: "column" }}>
        {loading && (
          <Center mih={200}>
            <Loader />
          </Center>
        )}

        {!loading && error && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} mb="md">
            {error}
          </Alert>
        )}

        {!loading && !error && rows.length === 0 && (
          <Center mih={200}>
            <Text c="dimmed">No items in this bin yet.</Text>
          </Center>
        )}

        {!loading && !error && rows.length > 0 && (
          <ScrollArea.Autosize mah="calc(100vh - 140px)">
            <Table
              highlightOnHover
              verticalSpacing="xs"
              striped
              withTableBorder
              withColumnBorders
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Card</Table.Th>
                  <Table.Th>Set</Table.Th>
                  <Table.Th>Condition</Table.Th>
                  <Table.Th>Foil</Table.Th>
                  <Table.Th ta="right">Qty in Bin</Table.Th>
                  <Table.Th>Row Breakdown</Table.Th>
                  <Table.Th>Notes</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((item) => (
                  <Table.Tr key={item._id}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text
                          fw={500}
                          style={{ cursor: "pointer" }}
                          onClick={() => handleOpenLocations(item._id)}
                        >
                          {item.name || "Unknown"}
                        </Text>
                        <Group gap="xs">
                          {item.cardTraderId && (
                            <Badge size="xs" variant="outline">
                              CT #{item.cardTraderId}
                            </Badge>
                          )}
                          {item.game && (
                            <Badge size="xs" variant="light">
                              {item.game}
                            </Badge>
                          )}
                        </Group>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.setCode || "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.condition || "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      {item.isFoil ? (
                        <Badge size="sm" color="yellow">
                          Foil
                        </Badge>
                      ) : (
                        <Text size="sm" c="dimmed">
                          Non-foil
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fw={600}>{item.qtyInBin}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.rowBreakdown}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {item.notes || ""}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
      </Box>

      {/* Modal: show ALL bins/rows for the clicked card */}
      <CardLocationsView
        itemId={selectedItemId}
        opened={locationsOpened}
        onClose={handleCloseLocations}
      />
    </Drawer>
  );
}
