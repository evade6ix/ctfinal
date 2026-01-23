import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Group,
  Loader,
  ScrollArea,
  Table,
  Text,
  Title,
} from "@mantine/core";

type ChangeLogEntry = {
  _id: string;
  type: string;
  source: string;
  message: string;
  orderId?: number;
  cardTraderId?: number;
  deltaQuantity?: number;
  createdAt: string;
};

const API_BASE = "/api";

export function ChangeLogsView() {
  const [logs, setLogs] = useState<ChangeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [page] = useState(1); // we can add pagination later

  async function fetchLogs() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/changelog?page=${page}&limit=50`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err) {
      console.error("Failed to fetch changelog", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchLogs();
  }, [page]);

  // "real-time": poll every 20s
  useEffect(() => {
    const id = setInterval(() => {
      fetchLogs();
    }, 20000);
    return () => clearInterval(id);
  }, [page]);

  const typeColor = (type: string) => {
    switch (type) {
      case "inventory-sync":
        return "blue";
      case "inventory-adjust":
        return "yellow";
      case "order-applied":
        return "green";
      case "bin-change":
        return "grape";
      default:
        return "gray";
    }
  };

  return (
    <Box p="md">
      <Group justify="space-between" mb="md">
        <div>
          <Title order={2}>Change logs</Title>
          <Text c="dimmed" size="sm">
            History of inventory syncs, quantity changes, and order-related
            updates.
          </Text>
        </div>
      </Group>

      {loading && (
        <Group justify="center" py="lg">
          <Loader />
        </Group>
      )}

      {!loading && logs.length === 0 && (
        <Text c="dimmed">No changes logged yet.</Text>
      )}

      {logs.length > 0 && (
        <ScrollArea>
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.map((log) => (
                <Table.Tr key={log._id}>
                  <Table.Td>
                    <Text size="sm">
                      {new Date(log.createdAt).toLocaleString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" color={typeColor(log.type)}>
                      {log.type}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light">
                      {log.source}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{log.message}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Box>
  );
}
