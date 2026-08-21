import type { ReactNode } from "react";
import { Badge, Box, Group, Paper, Text, ThemeIcon, Title } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" gap="lg" wrap="wrap" className="page-header">
      <Box maw={760}>
        {eyebrow && (
          <Text className="page-eyebrow" size="xs" fw={800} tt="uppercase">
            {eyebrow}
          </Text>
        )}
        <Title order={1} className="page-title">
          {title}
        </Title>
        <Text c="dimmed" mt={6} size="sm" lh={1.65}>
          {description}
        </Text>
      </Box>
      {actions && <Group gap="sm">{actions}</Group>}
    </Group>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "gold",
  badge,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  icon: TablerIcon;
  tone?: "gold" | "blue" | "green" | "red" | "violet";
  badge?: string;
}) {
  return (
    <Paper className={`metric-card metric-card--${tone}`} p="lg" radius="xl">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <ThemeIcon className="metric-card__icon" size={44} radius="lg" variant="light">
          <Icon size={22} stroke={1.8} />
        </ThemeIcon>
        {badge && (
          <Badge size="xs" variant="light" radius="xl">
            {badge}
          </Badge>
        )}
      </Group>
      <Text className="metric-card__value" mt="lg">
        {value}
      </Text>
      <Text fw={700} size="sm" mt={2}>
        {label}
      </Text>
      <Text c="dimmed" size="xs" mt={8} lh={1.5}>
        {detail}
      </Text>
    </Paper>
  );
}

export function StatusPill({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}) {
  return (
    <Badge
      className="status-pill"
      color={ok ? "teal" : "red"}
      variant="light"
      radius="xl"
      leftSection={<span className={`status-dot ${ok ? "status-dot--ok" : "status-dot--bad"}`} />}
    >
      {label}
    </Badge>
  );
}
