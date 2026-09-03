import {
  AppShell,
  Badge,
  Box,
  Burger,
  Group,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconBox,
  IconCards,
  IconHistory,
  IconLayoutDashboard,
  IconPackageExport,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";
import { useState } from "react";

import { CardListView } from "./components/CardListView";
import { CardTraderRepriceView } from "./components/CardTraderRepriceView";
import { CatalogSearchView } from "./components/CatalogSearchView";
import { ChangeLogsView } from "./components/ChangeLogView";
import { InventoryBinAssignmentView } from "./components/InventoryBinAssignmentView";
import { InventoryBinsView } from "./components/InventoryBinsView";
import { ManualAssignmentsView } from "./components/ManualAssignmentsView";
import { OrdersView } from "./components/OrdersView";
import { OrdersWeeklyGroupedView } from "./components/OrdersWeeklyGroupedView";

type Section =
  | "dashboard"
  | "card-list"
  | "inventory"
  | "bins"
  | "orders"
  | "manual-assignments"
  | "orders-weekly"
  | "repricer"
  | "changelogs"
  | "settings";

type NavigationItem = {
  value: Section;
  label: string;
  icon: typeof IconCards;
};

const NAVIGATION_GROUPS: { label: string; items: NavigationItem[] }[] = [
  {
    label: "Inventory",
    items: [
      { value: "dashboard", label: "Catalog Search", icon: IconLayoutDashboard },
      { value: "card-list", label: "Card List", icon: IconCards },
      { value: "inventory", label: "Inventory", icon: IconBox },
      { value: "bins", label: "Inventory Bins", icon: IconBox },
      { value: "repricer", label: "CardTrader Repricer", icon: IconRefresh },
      { value: "changelogs", label: "Change Logs", icon: IconHistory },
    ],
  },
  {
    label: "Fulfillment",
    items: [
      { value: "orders", label: "Orders", icon: IconPackageExport },
      { value: "manual-assignments", label: "Unassigned Lines", icon: IconAlertTriangle },
      { value: "orders-weekly", label: "Weekly Shipments", icon: IconPackageExport },
      { value: "settings", label: "Settings", icon: IconSettings },
    ],
  },
];

const SECTION_DETAILS: Record<Section, { eyebrow: string; title: string }> = {
  dashboard: { eyebrow: "Inventory", title: "Catalog Search" },
  "card-list": { eyebrow: "Inventory", title: "Card List" },
  inventory: { eyebrow: "Inventory", title: "Stock & Locations" },
  bins: { eyebrow: "Inventory", title: "Inventory Bins" },
  repricer: { eyebrow: "Inventory", title: "CardTrader Repricing" },
  changelogs: { eyebrow: "System", title: "Change Logs" },
  orders: { eyebrow: "Fulfillment", title: "Orders" },
  "manual-assignments": { eyebrow: "Fulfillment", title: "Unassigned Order Lines" },
  "orders-weekly": { eyebrow: "Fulfillment", title: "Weekly Shipments" },
  settings: { eyebrow: "System", title: "Settings" },
};

function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const [section, setSection] = useState<Section>("dashboard");
  const activeSection = SECTION_DETAILS[section];

  function navigateTo(value: Section) {
    setSection(value);
    close();
  }

  return (
    <AppShell
      className="ct-app"
      header={{ height: 64 }}
      navbar={{ width: 248, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding={{ base: 14, sm: 22, lg: 30 }}
      transitionDuration={180}
      classNames={{ header: "ct-header", navbar: "ct-navbar", main: "ct-main" }}
    >
      <AppShell.Header>
        <Group h="100%" px={{ base: "md", sm: "lg" }} justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <ThemeIcon className="brand-mark" size={32} radius={6} variant="filled">
              <IconCards size={18} stroke={1.9} />
            </ThemeIcon>
            <Text className="brand-name">CTFinal</Text>
          </Group>

          <Box className="header-context" ta="right">
            <Text className="context-eyebrow">{activeSection.eyebrow}</Text>
            <Text className="context-title">{activeSection.title}</Text>
          </Box>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar aria-label="Primary navigation">
        <ScrollArea type="auto" className="nav-scroll" scrollbarSize={5}>
          <Stack gap={26} px="sm" py="lg">
            {NAVIGATION_GROUPS.map((group) => (
              <Box key={group.label}>
                <Text className="nav-group-label">{group.label}</Text>
                <Stack gap={2} mt={8}>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = section === item.value;

                    return (
                      <NavLink
                        key={item.value}
                        className="app-nav-link"
                        label={item.label}
                        leftSection={<Icon className="nav-icon" size={17} stroke={1.8} />}
                        active={isActive}
                        onClick={() => navigateTo(item.value)}
                      />
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box className="page-frame">
          {section === "dashboard" && <CatalogSearchView />}
          {section === "card-list" && <CardListView />}
          {section === "inventory" && <InventoryBinAssignmentView />}
          {section === "bins" && <InventoryBinsView />}
          {section === "repricer" && <CardTraderRepriceView />}
          {section === "orders" && <OrdersView />}
          {section === "manual-assignments" && <ManualAssignmentsView />}
          {section === "orders-weekly" && <OrdersWeeklyGroupedView />}
          {section === "changelogs" && <ChangeLogsView />}
          {section === "settings" && (
            <Paper className="settings-placeholder" withBorder radius="md" p={{ base: "xl", sm: 36 }}>
              <ThemeIcon size={44} radius={8} variant="light">
                <IconSettings size={22} stroke={1.7} />
              </ThemeIcon>
              <Box>
                <Group gap="sm" mb={6}>
                  <Title order={2}>Settings</Title>
                  <Badge variant="light" radius="sm">Coming soon</Badge>
                </Group>
                <Text c="dimmed" maw={560}>
                  Workspace preferences, API configuration, and connection management will live here.
                </Text>
              </Box>
            </Paper>
          )}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;