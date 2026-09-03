import {
  AppShell,
  Box,
  Burger,
  Group,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Text,
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
      navbar={{ width: 236, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding={0}
      transitionDuration={160}
      classNames={{ navbar: "ct-navbar", main: "ct-main" }}
    >
      <AppShell.Navbar aria-label="Primary navigation">
        <Group className="sidebar-brand" gap="sm" wrap="nowrap">
          <Box className="brand-symbol" aria-hidden="true" />
          <Text className="brand-name">CTFinal</Text>
        </Group>

        <ScrollArea type="auto" className="nav-scroll" scrollbarSize={5}>
          <Stack gap={30} px={12} py={18}>
            {NAVIGATION_GROUPS.map((group) => (
              <Box key={group.label}>
                <Text className="nav-group-label">{group.label}</Text>
                <Stack gap={3} mt={8}>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = section === item.value;

                    return (
                      <NavLink
                        key={item.value}
                        className="app-nav-link"
                        label={item.label}
                        leftSection={<Icon className="nav-icon" size={16} stroke={1.8} />}
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
        <Box className="content-toolbar">
          <Group h="100%" px={{ base: 16, sm: 24, lg: 32 }} gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <Text className="mobile-brand" hiddenFrom="sm">CTFinal</Text>
            <Group className="toolbar-breadcrumb" gap={7} wrap="nowrap">
              <Text className="section-parent">{activeSection.eyebrow}</Text>
              <Text className="breadcrumb-slash">/</Text>
              <Text className="section-name">{activeSection.title}</Text>
            </Group>
          </Group>
        </Box>

        <Box className="content-area">
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
              <Paper className="settings-placeholder" withBorder p={{ base: "xl", sm: 32 }}>
                <Title order={2}>Settings</Title>
                <Text c="dimmed" mt={6}>Settings aren’t available yet.</Text>
              </Paper>
            )}
          </Box>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;