import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Image,
  Loader,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconMapPin,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { PageHeader } from "./ui/OperationsUI";

type PickingItem = {
  id: string;
  source: "cardtrader" | "manapool";
  orderId: string;
  orderCode: string;
  name: string;
  setCode?: string | null;
  condition?: string | null;
  isFoil: boolean;
  imageUrl?: string | null;
  requestedQuantity: number;
  status: "allocated" | "manual_review";
  failureReason?: string | null;
  picked: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  locations: Array<{ binId?: string; binName: string; row?: number | null; quantity: number }>;
  primaryLocation?: { binName: string; row?: number | null } | null;
};

type PickingPayload = {
  items: PickingItem[];
  summary: {
    lines: number;
    cards: number;
    pickedLines: number;
    unpickedLines: number;
    exceptions: number;
    cardtrader: number;
    manapool: number;
  };
  truncated: boolean;
};

function locationKey(item: PickingItem) {
  if (item.status === "manual_review") return "00|Exceptions";
  return `${item.primaryLocation?.binName || "ZZZ"}|${String(item.primaryLocation?.row || 999).padStart(3, "0")}`;
}

function locationLabel(item: PickingItem) {
  if (item.status === "manual_review") return "Manual exceptions";
  const location = item.primaryLocation;
  if (!location) return "Unassigned location";
  return `${location.binName}${location.row ? ` · Row ${location.row}` : ""}`;
}

export function UnifiedPickingView({ staffName }: { staffName: string }) {
  const [payload, setPayload] = useState<PickingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("all");
  const [mode, setMode] = useState("active");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ mode, limit: "2000" });
      if (source !== "all") params.set("source", source);
      if (search.trim()) params.set("search", search.trim());
      if (mode === "unpicked") {
        params.set("mode", "active");
        params.set("picked", "false");
      }
      if (mode === "picked") {
        params.set("mode", "active");
        params.set("picked", "true");
      }

      const response = await fetch(`/api/picking/queue?${params.toString()}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to load picking queue");
      setPayload(data);
      setSelected((current) => new Set([...current].filter((id) => data.items.some((item: PickingItem) => item.id === id))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load picking queue");
    } finally {
      setLoading(false);
    }
  }, [mode, search, source]);

  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const groups = useMemo(() => {
    const grouped = new Map<string, PickingItem[]>();
    for (const item of payload?.items || []) {
      const key = locationKey(item);
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [payload]);

  const updateLine = async (item: PickingItem, picked: boolean) => {
    setUpdating((current) => new Set(current).add(item.id));
    try {
      const response = await fetch(`/api/picking/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ picked, pickedBy: staffName || "local" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to update picking line");
      await load();
    } catch (err) {
      notifications.show({ color: "red", title: "Pick update failed", message: err instanceof Error ? err.message : "Please try again" });
    } finally {
      setUpdating((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const batchUpdate = async (picked: boolean) => {
    if (!selected.size) return;
    try {
      const response = await fetch("/api/picking/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocationIds: [...selected], picked, pickedBy: staffName || "local" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to update selected lines");
      notifications.show({ color: "teal", title: "Pick route updated", message: `${data.modified} lines were ${picked ? "completed" : "reopened"}.` });
      setSelected(new Set());
      await load();
    } catch (err) {
      notifications.show({ color: "red", title: "Batch update failed", message: err instanceof Error ? err.message : "Please try again" });
    }
  };

  const progress = payload?.summary.lines
    ? Math.round((payload.summary.pickedLines / payload.summary.lines) * 100)
    : 0;

  return (
    <Stack gap="xl">
      <PageHeader
        eyebrow="Unified fulfillment"
        title="Pick route"
        description="CardTrader and ManaPool lines are merged into one warehouse route, automatically ordered by bin and row. Exceptions stay at the top so they cannot be missed."
        actions={<Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load} loading={loading}>Refresh</Button>}
      />

      <Paper className="surface-card picking-toolbar" p="lg" radius="xl">
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
          <SegmentedControl
            value={mode}
            onChange={setMode}
            fullWidth
            data={[
              { label: "All active", value: "active" },
              { label: "Unpicked", value: "unpicked" },
              { label: "Picked", value: "picked" },
              { label: "Exceptions", value: "exceptions" },
            ]}
          />
          <Select
            value={source}
            onChange={(value) => setSource(value || "all")}
            data={[
              { label: "All marketplaces", value: "all" },
              { label: "CardTrader", value: "cardtrader" },
              { label: "ManaPool", value: "manapool" },
            ]}
          />
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search card or order…"
            leftSection={<IconSearch size={16} />}
          />
        </SimpleGrid>
      </Paper>

      {error && <Alert color="red" title="Picking queue unavailable">{error}</Alert>}

      {payload && (
        <Paper className="pick-progress" p="lg" radius="xl">
          <Group justify="space-between" mb="sm" wrap="wrap">
            <Group gap="xl">
              <div><Text size="xl" fw={850}>{payload.summary.unpickedLines}</Text><Text size="xs" c="dimmed">lines remaining</Text></div>
              <div><Text size="xl" fw={850}>{payload.summary.cards}</Text><Text size="xs" c="dimmed">cards on route</Text></div>
              <div><Text size="xl" fw={850} c={payload.summary.exceptions ? "orange" : undefined}>{payload.summary.exceptions}</Text><Text size="xs" c="dimmed">exceptions</Text></div>
            </Group>
            <Group>
              {selected.size > 0 && (
                <>
                  <Text size="sm" c="dimmed">{selected.size} selected</Text>
                  <Button size="sm" color="teal" onClick={() => batchUpdate(true)}>Mark picked</Button>
                  <Button size="sm" variant="default" onClick={() => batchUpdate(false)}>Reopen</Button>
                </>
              )}
              <Badge size="lg" color={progress === 100 ? "teal" : "yellow"} variant="light">{progress}% complete</Badge>
            </Group>
          </Group>
          <Progress value={progress} color="yellow" radius="xl" size={10} />
        </Paper>
      )}

      {loading && !payload ? <Group justify="center" py={80}><Loader /></Group> : null}

      <Stack gap="lg">
        {groups.map(([key, items]) => {
          const first = items[0];
          const isException = first.status === "manual_review";
          return (
            <Paper key={key} className={`pick-location ${isException ? "pick-location--exception" : ""}`} radius="xl">
              <Group className="pick-location__header" justify="space-between" p="md" wrap="wrap">
                <Group>
                  <ThemeIcon variant="light" color={isException ? "orange" : "yellow"} radius="lg">
                    {isException ? <IconAlertTriangle size={18} /> : <IconMapPin size={18} />}
                  </ThemeIcon>
                  <div>
                    <Text fw={800}>{locationLabel(first)}</Text>
                    <Text size="xs" c="dimmed">{items.length} line{items.length === 1 ? "" : "s"} at this stop</Text>
                  </div>
                </Group>
                {!isException && (
                  <Checkbox
                    label="Select stop"
                    checked={items.every((item) => selected.has(item.id))}
                    indeterminate={items.some((item) => selected.has(item.id)) && !items.every((item) => selected.has(item.id))}
                    onChange={(event) => {
                      const next = new Set(selected);
                      items.forEach((item) => event.currentTarget.checked ? next.add(item.id) : next.delete(item.id));
                      setSelected(next);
                    }}
                  />
                )}
              </Group>
              <Stack gap={0}>
                {items.map((item) => (
                  <Group key={item.id} className={`pick-line ${item.picked ? "pick-line--picked" : ""}`} p="md" wrap="nowrap" align="center">
                    <Checkbox
                      checked={selected.has(item.id)}
                      disabled={isException}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.currentTarget.checked) next.add(item.id); else next.delete(item.id);
                        setSelected(next);
                      }}
                    />
                    <Image src={item.imageUrl || "/card-placeholder.png"} w={42} h={58} fit="contain" radius="sm" fallbackSrc="/card-placeholder.png" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs" wrap="wrap">
                        <Text fw={750} size="sm" lineClamp={1}>{item.name}</Text>
                        {item.isFoil && <Badge size="xs" variant="gradient" gradient={{ from: "violet", to: "yellow" }}>Foil</Badge>}
                        <Badge size="xs" variant="light" color={item.source === "cardtrader" ? "blue" : "grape"}>{item.source}</Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        {item.setCode || "Unknown set"} · {item.condition || "Unknown condition"} · Order {item.orderCode}
                      </Text>
                      {isException && <Text size="xs" c="orange" mt={4}>{item.failureReason || "No exact inventory allocation was available."}</Text>}
                    </div>
                    <Badge size="lg" variant="light" color="gray">×{item.requestedQuantity}</Badge>
                    {!isException && (
                      <ActionIcon
                        size={42}
                        radius="xl"
                        variant={item.picked ? "light" : "filled"}
                        color={item.picked ? "teal" : "yellow"}
                        c={item.picked ? undefined : "dark.9"}
                        loading={updating.has(item.id)}
                        onClick={() => updateLine(item, !item.picked)}
                        aria-label={item.picked ? "Reopen line" : "Mark picked"}
                      >
                        {item.picked ? <IconCheck size={20} /> : <IconChevronRight size={20} />}
                      </ActionIcon>
                    )}
                  </Group>
                ))}
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      {!loading && payload?.items.length === 0 && (
        <Paper className="empty-state" p={60} radius="xl">
          <ThemeIcon size={58} radius="xl" color="teal" variant="light"><IconCheck size={28} /></ThemeIcon>
          <Text fw={800} size="lg" mt="md">This queue is clear</Text>
          <Text c="dimmed" size="sm">There are no lines matching the current filters.</Text>
        </Paper>
      )}
    </Stack>
  );
}
