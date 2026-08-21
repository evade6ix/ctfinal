import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Code, Group, Loader, Paper, Select, Stack, Table, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { PageHeader } from "./ui/OperationsUI";

type OperationRun = {
  _id: string;
  label: string;
  kind: string;
  source: string;
  trigger: string;
  status: string;
  initiatedBy: string;
  startedAt: string;
  durationMs?: number | null;
  summary?: Record<string, unknown>;
  errorDetails?: Array<Record<string, unknown>>;
};

export function OperationHistoryView() {
  const [runs, setRuns] = useState<OperationRun[]>([]);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ limit: "100" });
      if (status !== "all") params.set("status", status);
      const response = await fetch(`/api/operations/runs?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load operation history");
      setRuns(payload.runs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load operation history");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow="Durable audit trail"
        title="Operation history"
        description="Marketplace syncs, repricing jobs, staged listing pushes, and batch picking actions remain visible after restarts, including partial failures and initiating staff."
        actions={
          <>
            <Select value={status} onChange={(value) => setStatus(value || "all")} data={[
              { label: "All statuses", value: "all" },
              { label: "Completed", value: "completed" },
              { label: "Completed with errors", value: "completed_with_errors" },
              { label: "Failed", value: "failed" },
            ]} />
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load}>Refresh</Button>
          </>
        }
      />
      {error && <Alert color="red">{error}</Alert>}
      <Paper className="surface-card" p="lg" radius="xl">
        {loading ? <Group justify="center" py={60}><Loader /></Group> : runs.length ? (
          <Table verticalSpacing="md" highlightOnHover>
            <Table.Thead><Table.Tr><Table.Th>Operation</Table.Th><Table.Th>Status</Table.Th><Table.Th>Initiated by</Table.Th><Table.Th>Started</Table.Th><Table.Th>Duration</Table.Th><Table.Th>Summary</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {runs.map((run) => (
                <Table.Tr key={run._id}>
                  <Table.Td><Text fw={750} size="sm">{run.label}</Text><Text size="xs" c="dimmed">{run.kind} · {run.source}</Text></Table.Td>
                  <Table.Td><Badge variant="light" color={run.status === "completed" ? "teal" : run.status === "failed" ? "red" : "yellow"}>{run.status.replaceAll("_", " ")}</Badge></Table.Td>
                  <Table.Td><Text size="sm">{run.initiatedBy || "system"}</Text></Table.Td>
                  <Table.Td><Text size="sm">{new Date(run.startedAt).toLocaleString("en-CA")}</Text></Table.Td>
                  <Table.Td><Text size="sm">{run.durationMs == null ? "—" : `${(run.durationMs / 1000).toFixed(1)}s`}</Text></Table.Td>
                  <Table.Td><Code className="summary-code">{JSON.stringify(run.summary || {})}</Code></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : <Text c="dimmed" py="xl">No operations have been recorded yet.</Text>}
      </Paper>
    </Stack>
  );
}
