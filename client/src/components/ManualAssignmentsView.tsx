import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

const API_BASE = "/api";

type ManualAllocation = {
  allocationId: string;
  orderId: string;
  orderCode?: string | null;
  orderItemId: number;
  cardTraderId?: number | null;
  name: string;
  condition?: string | null;
  isFoil?: boolean;
  requestedQuantity: number;
  failureReason?: string | null;
  duplicateCount?: number;
};

type CandidateLocation = {
  bin?: string | null;
  row?: number | null;
  quantity: number;
};

type Candidate = {
  inventoryItemId: string;
  cardTraderId?: number | null;
  blueprintId?: number | null;
  name?: string | null;
  setCode?: string | null;
  condition?: string | null;
  isFoil?: boolean;
  totalQuantity: number;
  assignedQuantity: number;
  locations: CandidateLocation[];
  eligible: boolean;
  ineligibleReasons: string[];
};

type CandidateResponse = {
  allocation: ManualAllocation;
  orderContext?: {
    orderCode?: string | null;
    setName?: string | null;
    setCode?: string | null;
    blueprintId?: number | null;
    cardTraderId?: number | null;
    contextError?: unknown;
  };
  candidates: Candidate[];
};

function locationLabel(locations: CandidateLocation[]) {
  if (!locations.length) return "No assigned locations";
  return locations
    .filter((location) => Number(location.quantity || 0) > 0)
    .map(
      (location) =>
        `${location.bin || "?"} / Row ${location.row || "?"} × ${location.quantity}`
    )
    .join(", ");
}

export function ManualAssignmentsView() {
  const [allocations, setAllocations] = useState<ManualAllocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [candidateData, setCandidateData] = useState<
    Record<string, CandidateResponse>
  >({});
  const [selectedIds, setSelectedIds] = useState<Record<string, string[]>>({});
  const [loadingCandidatesId, setLoadingCandidatesId] = useState<string | null>(
    null
  );
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadAllocations() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/manual-assignments`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ManualAllocation[];
      setAllocations(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load unassigned order lines");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAllocations();
  }, []);

  async function loadCandidates(allocationId: string) {
    setLoadingCandidatesId(allocationId);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `${API_BASE}/manual-assignments/${allocationId}/candidates`
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as CandidateResponse;
      setCandidateData((prev) => ({ ...prev, [allocationId]: data }));
      setExpandedId(allocationId);

      const eligible = (data.candidates || []).filter(
        (candidate) => candidate.eligible && candidate.assignedQuantity > 0
      );
      let remaining = Number(data.allocation.requestedQuantity || 0);
      const recommended: string[] = [];
      for (const candidate of eligible) {
        if (remaining <= 0) break;
        recommended.push(candidate.inventoryItemId);
        remaining -= candidate.assignedQuantity;
      }
      setSelectedIds((prev) => ({ ...prev, [allocationId]: recommended }));
    } catch (err: any) {
      setError(err?.message || "Failed to load Card List candidates");
    } finally {
      setLoadingCandidatesId(null);
    }
  }

  function toggleCandidate(allocationId: string, inventoryItemId: string) {
    setSelectedIds((prev) => {
      const current = new Set(prev[allocationId] || []);
      if (current.has(inventoryItemId)) current.delete(inventoryItemId);
      else current.add(inventoryItemId);
      return { ...prev, [allocationId]: [...current] };
    });
  }

  async function assignSelected(allocation: ManualAllocation) {
    const inventoryItemIds = selectedIds[allocation.allocationId] || [];
    if (!inventoryItemIds.length) return;

    setAssigningId(allocation.allocationId);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `${API_BASE}/manual-assignments/${allocation.allocationId}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inventoryItemIds,
            manuallyAssignedBy: "Manual Assignments UI",
          }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.details || body?.error || JSON.stringify(body));
      }

      const failedSyncs = Array.isArray(body?.manaPoolSyncs)
        ? body.manaPoolSyncs.filter((sync: any) => sync?.ok !== true)
        : [];
      setMessage(
        failedSyncs.length
          ? `${allocation.name} was assigned and deducted, but ${failedSyncs.length} ManaPool sync(s) reported an error.`
          : `${allocation.name} was assigned from Card List, deducted, and synced to ManaPool.`
      );
      setExpandedId(null);
      setCandidateData((prev) => {
        const next = { ...prev };
        delete next[allocation.allocationId];
        return next;
      });
      await loadAllocations();
    } catch (err: any) {
      setError(err?.message || "Manual assignment failed");
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <Box p="md">
      <Group justify="space-between" align="flex-start" mb="md">
        <div>
          <Title order={2}>Unassigned Order Lines</Title>
          <Text c="dimmed" size="sm">
            Select the exact Card List inventory records to convert a manual-review
            line into a real allocation. This deducts stock and syncs ManaPool.
          </Text>
        </div>
        <Button variant="light" onClick={loadAllocations} loading={loading}>
          Refresh
        </Button>
      </Group>

      {message && (
        <Alert color="green" mb="md" title="Assignment completed">
          {message}
        </Alert>
      )}

      {error && (
        <Alert color="red" mb="md" title="Could not complete assignment">
          {error}
        </Alert>
      )}

      {loading && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text c="dimmed">Loading unassigned lines…</Text>
        </Group>
      )}

      {!loading && allocations.length === 0 && (
        <Paper withBorder radius="md" p="xl">
          <Text fw={600}>No unassigned manual-review lines remain.</Text>
          <Text c="dimmed" size="sm">
            Daily Sales should now contain real bin and row allocations.
          </Text>
        </Paper>
      )}

      <Stack gap="md">
        {allocations.map((allocation) => {
          const data = candidateData[allocation.allocationId];
          const selected = selectedIds[allocation.allocationId] || [];
          const selectedCandidates = (data?.candidates || []).filter((candidate) =>
            selected.includes(candidate.inventoryItemId)
          );
          const selectedQuantity = selectedCandidates.reduce(
            (sum, candidate) => sum + candidate.assignedQuantity,
            0
          );
          const enoughSelected = selectedQuantity >= allocation.requestedQuantity;

          return (
            <Card key={allocation.allocationId} withBorder radius="lg" p="md">
              <Group justify="space-between" align="flex-start">
                <Stack gap={4}>
                  <Group gap="xs">
                    <Text fw={700}>{allocation.name}</Text>
                    <Badge color={allocation.isFoil ? "yellow" : "gray"}>
                      {allocation.isFoil ? "Foil" : "Non-Foil"}
                    </Badge>
                    <Badge variant="light">{allocation.condition || "Unknown"}</Badge>
                    <Badge color="red" variant="light">
                      Qty {allocation.requestedQuantity} unassigned
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Order {allocation.orderCode || allocation.orderId} · Line {allocation.orderItemId}
                    {allocation.cardTraderId
                      ? ` · CardTrader ID ${allocation.cardTraderId}`
                      : ""}
                  </Text>
                  {allocation.failureReason && (
                    <Text size="xs" c="red">
                      Current reason: {allocation.failureReason}
                    </Text>
                  )}
                  {(allocation.duplicateCount || 1) > 1 && (
                    <Text size="xs" c="orange">
                      {allocation.duplicateCount} duplicate manual-review records were found;
                      stale copies will be removed after assignment.
                    </Text>
                  )}
                </Stack>

                <Button
                  size="sm"
                  loading={loadingCandidatesId === allocation.allocationId}
                  onClick={() =>
                    expandedId === allocation.allocationId
                      ? setExpandedId(null)
                      : loadCandidates(allocation.allocationId)
                  }
                >
                  {expandedId === allocation.allocationId
                    ? "Hide Card List stock"
                    : "Find Card List stock"}
                </Button>
              </Group>

              {expandedId === allocation.allocationId && data && (
                <Stack mt="md" gap="sm">
                  <Group gap="xs">
                    <Badge variant="outline">
                      Expected set: {data.orderContext?.setCode || data.orderContext?.setName || "Unknown"}
                    </Badge>
                    {data.orderContext?.blueprintId && (
                      <Badge variant="outline">
                        Blueprint {data.orderContext.blueprintId}
                      </Badge>
                    )}
                  </Group>

                  <ScrollArea>
                    <Table striped highlightOnHover withColumnBorders>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Select</Table.Th>
                          <Table.Th>Set</Table.Th>
                          <Table.Th>Card List ID</Table.Th>
                          <Table.Th>Variant</Table.Th>
                          <Table.Th>Available</Table.Th>
                          <Table.Th>Locations</Table.Th>
                          <Table.Th>Status</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {(data.candidates || []).map((candidate) => (
                          <Table.Tr key={candidate.inventoryItemId}>
                            <Table.Td>
                              <Checkbox
                                checked={selected.includes(candidate.inventoryItemId)}
                                disabled={!candidate.eligible}
                                onChange={() =>
                                  toggleCandidate(
                                    allocation.allocationId,
                                    candidate.inventoryItemId
                                  )
                                }
                              />
                            </Table.Td>
                            <Table.Td>{candidate.setCode || "-"}</Table.Td>
                            <Table.Td>
                              <Text size="xs">{candidate.inventoryItemId}</Text>
                              <Text size="xs" c="dimmed">
                                CT {candidate.cardTraderId || "-"}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              {candidate.isFoil ? "Foil" : "Non-Foil"} · {candidate.condition || "-"}
                            </Table.Td>
                            <Table.Td>{candidate.assignedQuantity}</Table.Td>
                            <Table.Td>{locationLabel(candidate.locations)}</Table.Td>
                            <Table.Td>
                              {candidate.eligible ? (
                                <Badge color="green">Eligible</Badge>
                              ) : (
                                <Stack gap={2}>
                                  <Badge color="red">Not eligible</Badge>
                                  <Text size="xs" c="dimmed">
                                    {candidate.ineligibleReasons.join(", ")}
                                  </Text>
                                </Stack>
                              )}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                        {(data.candidates || []).length === 0 && (
                          <Table.Tr>
                            <Table.Td colSpan={7}>
                              <Text c="dimmed" size="sm">
                                No exact-name Card List records were found.
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea>

                  <Group justify="space-between">
                    <Text size="sm" c={enoughSelected ? "green" : "red"}>
                      Selected assigned quantity: {selectedQuantity} / {allocation.requestedQuantity}
                    </Text>
                    <Button
                      color="green"
                      disabled={!enoughSelected || selected.length === 0}
                      loading={assigningId === allocation.allocationId}
                      onClick={() => assignSelected(allocation)}
                    >
                      Assign selected stock
                    </Button>
                  </Group>
                </Stack>
              )}
            </Card>
          );
        })}
      </Stack>
    </Box>
  );
}
