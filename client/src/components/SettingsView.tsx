import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Paper, SimpleGrid, Stack, Switch, Text, TextInput, ThemeIcon, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCloudCheck, IconDatabase, IconDeviceFloppy, IconRefresh, IconUser } from "@tabler/icons-react";
import { PageHeader, StatusPill } from "./ui/OperationsUI";

type SettingsStatus = {
  server: { node: string; environment: string; uptimeSeconds: number };
  database: { connected: boolean; state: string };
  marketplaces: { cardTraderConfigured: boolean; manaPoolConfigured: boolean };
  automation: { enabled: boolean; cardTraderEnabled: boolean; manaPoolEnabled: boolean; intervalMs: number; runOnStartup: boolean };
};

export function SettingsView({ staffName, onStaffNameChange }: { staffName: string; onStaffNameChange: (value: string) => void }) {
  const [draftName, setDraftName] = useState(staffName);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const response = await fetch("/api/settings/status");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load settings");
      setStatus(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load settings");
    }
  };

  useEffect(() => { load(); }, []);

  const save = () => {
    const value = draftName.trim() || "Local staff";
    onStaffNameChange(value);
    setDraftName(value);
    notifications.show({ color: "teal", title: "Staff profile saved", message: `Future pick actions will be recorded as ${value}.` });
  };

  return (
    <Stack gap="xl">
      <PageHeader eyebrow="Workspace preferences" title="Settings" description="Configure the local staff identity used in the audit trail and inspect the live status of CTFinal’s server, database, marketplaces, and automation worker." actions={<Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load}>Refresh status</Button>} />
      {error && <Alert color="red">{error}</Alert>}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Paper className="surface-card" p="xl" radius="xl">
          <Group gap="md" mb="lg"><ThemeIcon size={44} radius="lg" variant="light"><IconUser size={22} /></ThemeIcon><div><Title order={3}>Staff identity</Title><Text size="sm" c="dimmed">Used for picks and manual operations on this device.</Text></div></Group>
          <TextInput label="Display name" description="Example: Joe, Mario, Shipping Desk" value={draftName} onChange={(event) => setDraftName(event.currentTarget.value)} />
          <Button mt="lg" leftSection={<IconDeviceFloppy size={16} />} onClick={save}>Save profile</Button>
        </Paper>
        <Paper className="surface-card" p="xl" radius="xl">
          <Group gap="md" mb="lg"><ThemeIcon size={44} radius="lg" color="blue" variant="light"><IconDatabase size={22} /></ThemeIcon><div><Title order={3}>Core services</Title><Text size="sm" c="dimmed">Read-only connection status. Credential values are never displayed.</Text></div></Group>
          <Stack gap="md">
            <Group justify="space-between"><Text size="sm">MongoDB</Text><StatusPill ok={!!status?.database.connected} label={status?.database.state || "Checking"} /></Group>
            <Group justify="space-between"><Text size="sm">CardTrader</Text><StatusPill ok={!!status?.marketplaces.cardTraderConfigured} label={status?.marketplaces.cardTraderConfigured ? "Configured" : "Missing"} /></Group>
            <Group justify="space-between"><Text size="sm">ManaPool</Text><StatusPill ok={!!status?.marketplaces.manaPoolConfigured} label={status?.marketplaces.manaPoolConfigured ? "Configured" : "Missing"} /></Group>
          </Stack>
        </Paper>
      </SimpleGrid>
      <Paper className="surface-card" p="xl" radius="xl">
        <Group gap="md" mb="lg"><ThemeIcon size={44} radius="lg" color="teal" variant="light"><IconCloudCheck size={22} /></ThemeIcon><div><Title order={3}>Order automation</Title><Text size="sm" c="dimmed">Current environment configuration for the background reconciliation worker.</Text></div></Group>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <Switch checked={!!status?.automation.enabled} readOnly label="Automatic sync" description="Master worker state" />
          <Switch checked={!!status?.automation.cardTraderEnabled} readOnly label="CardTrader sync" description="Reconcile eligible orders" />
          <Switch checked={!!status?.automation.manaPoolEnabled} readOnly label="ManaPool sync" description="Reconcile eligible orders" />
          <div><Text size="xs" c="dimmed">Sync interval</Text><Badge mt={6} variant="light" size="lg">Every {Math.round((status?.automation.intervalMs || 60000) / 1000)} seconds</Badge></div>
        </SimpleGrid>
      </Paper>
    </Stack>
  );
}
