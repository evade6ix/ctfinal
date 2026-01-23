import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  SimpleGrid,
  Text,
  TextInput,
  Title,
  Badge,
  Stack,
} from "@mantine/core";
import { BinDetailView } from "./BinDetailView";

type Bin = {
  _id: string;
  name: string;
  rows: number;
  description?: string;
};

const API_BASE = "/api";

export function InventoryBinsView() {
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(false);

  const [newName, setNewName] = useState("");
  const [newRows, setNewRows] = useState<number | "">(3);
  const [newDescription, setNewDescription] = useState("");

  // state for bin detail drawer
  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  const [selectedBinName, setSelectedBinName] = useState<string | undefined>(
    undefined
  );
  const [detailOpened, setDetailOpened] = useState(false);

  async function fetchBins() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/bins`);
      const data = await res.json();
      setBins(data);
    } catch (err) {
      console.error("Failed to fetch bins", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBins();
  }, []);

  async function handleCreateBin() {
    if (!newName || !newRows) return;
    try {
      const res = await fetch(`${API_BASE}/bins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          rows: newRows,
          description: newDescription,
        }),
      });

      if (!res.ok) {
        console.error("Failed to create bin");
        return;
      }

      setNewName("");
      setNewRows(3);
      setNewDescription("");
      await fetchBins();
    } catch (err) {
      console.error("Failed to create bin", err);
    }
  }

  function handleOpenBin(bin: Bin) {
    setSelectedBinId(bin._id);
    setSelectedBinName(bin.name);
    setDetailOpened(true);
  }

  function handleCloseDetail() {
    setDetailOpened(false);
    // If you want to clear selection when closed:
    // setSelectedBinId(null);
  }

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Title order={2}>Inventory Bins</Title>
          <Text c="dimmed" size="sm">
            Create bins (1–5 rows) and assign cards into them. This is where
            you’ll do the big one-time organization of existing inventory.
          </Text>
        </div>
      </Group>

      <Card withBorder mb="lg" radius="lg">
        <Title order={4} mb="sm">
          Create a new bin
        </Title>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Bin name"
            placeholder="Bin A, Bin B2, etc."
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            w={200}
          />
          <NumberInput
            label="Rows"
            min={1}
            max={5}
            value={newRows}
            w={120}
            onChange={(val) => {
              if (val === "") return setNewRows("");
              setNewRows(Number(val));
            }}
          />
          <TextInput
            label="Description"
            placeholder="Optional note"
            value={newDescription}
            onChange={(e) => setNewDescription(e.currentTarget.value)}
            w={260}
          />
          <Button onClick={handleCreateBin}>Add Bin</Button>
        </Group>
      </Card>

      <Title order={4} mb="sm">
        Existing bins
      </Title>
      {loading && <Text c="dimmed">Loading bins…</Text>}

      {!loading && bins.length === 0 && (
        <Text c="dimmed">No bins yet. Create your first one above.</Text>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mt="sm">
        {bins.map((bin) => (
          <Card
            key={bin._id}
            withBorder
            radius="lg"
            style={{ cursor: "pointer" }}
            onClick={() => handleOpenBin(bin)}
          >
            <Group justify="space-between" mb="xs">
              <Text fw={600}>{bin.name}</Text>
              <Badge radius="xl" variant="light">
                {bin.rows} row{bin.rows === 1 ? "" : "s"}
              </Badge>
            </Group>
            {bin.description && (
              <Text size="sm" c="dimmed" mb="xs">
                {bin.description}
              </Text>
            )}
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                Click to view all cards in this bin and their row positions.
              </Text>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      {/* Bin detail drawer */}
      <BinDetailView
        binId={selectedBinId}
        binName={selectedBinName}
        opened={detailOpened}
        onClose={handleCloseDetail}
      />
    </Box>
  );
}
