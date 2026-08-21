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
  IconChevronRight,
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
  description: string;
  icon: typeof IconCards;
};

const NAVIGATION_GROUPS: { label: string; items: NavigationItem[] }[] = [
  {
    label: "Inventory",
    items: [
      {
        value: "dashboard",
        label: "Catalog Search",
        description: "Find and stage listings",
        icon: IconLayoutDashboard,
      },
      {
        value: "card-list",
        label: "Card List",
        description: "Browse live inventory",
        icon: IconCards,
      },
      {
        value: "inventory",
        label: "Inventory",
        description: "Stock and locations",
        icon: IconBox,
      },
      {
        value: "bins",
        label: "Inventory Bins",
        description: "Manage physical storage",
        icon: IconBox,
      },
      {
        value: "repricer",
        label: "CardTrader Repricer",
        description: "Preview and update prices",
        icon: IconRefresh,
      },
      {
        value: "changelogs",
        label: "Change Logs",
        description: "Review sync history",
        icon: IconHistory,
      },
    ],
  },
  {
    label: "Fulfillment",
    items: [
      {
        value: "orders",
        label: "Orders",
        description: "Daily order workflow",
        icon: IconPackageExport,
      },
      {
        value: "manual-assignments",
        label: "Unassigned Lines",
        description: "Resolve inventory matches",
        icon: IconAlertTriangle,
      },
      {
        value: "orders-weekly",
        label: "Weekly Shipments",
        description: "Wednesday to Tuesday",
        icon: IconPackageExport,
      },
      {
        value: "settings",
        label: "Settings",
        description: "Workspace preferences",
        icon: IconSettings,
      },
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
      header={{ height: 76 }}
      navbar={{ width: 292, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding={{ base: 14, sm: 20, lg: 26 }}
      transitionDuration={220}
      classNames={{ header: "ct-header", navbar: "ct-navbar", main: "ct-main" }}
    >
      <AppShell.Header>
        <Group h="100%" px={{ base: "md", sm: "xl" }} justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <ThemeIcon className="brand-mark" size={42} radius={12} variant="filled">
              <IconCards size={23} stroke={1.8} />
            </ThemeIcon>
            <Box className="brand-copy">
              <Text className="brand-name">CTFinal</Text>
              <Text className="brand-subtitle">Inventory operations</Text>
            </Box>
          </Group>

          <Group gap="lg" wrap="nowrap" className="header-context">
            <Box ta="right">
              <Text className="context-eyebrow">{activeSection.eyebrow}</Text>
              <Text className="context-title">{activeSection.title}</Text>
            </Box>
            <Badge className="workspace-badge" variant="light" size="lg" radius="xl">
              Workspace
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar aria-label="Primary navigation">
        <Box className="nav-intro">
          <Text className="nav-intro-label">Operations console</Text>
          <Text className="nav-intro-copy">
            Catalog, inventory, pricing, and fulfillment in one place.
          </Text>
        </Box>

        <ScrollArea type="auto" className="nav-scroll" scrollbarSize={6}>
          <Stack gap={22} px="sm" py="md">
            {NAVIGATION_GROUPS.map((group) => (
              <Box key={group.label}>
                <Text className="nav-group-label">{group.label}</Text>
                <Stack gap={4} mt={7}>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = section === item.value;

                    return (
                      <NavLink
                        key={item.value}
                        className="app-nav-link"
                        label={item.label}
                        description={item.description}
                        leftSection={
                          <ThemeIcon
                            className="nav-icon"
                            size={34}
                            radius={9}
                            variant={isActive ? "filled" : "light"}
                          >
                            <Icon size={18} stroke={1.8} />
                          </ThemeIcon>
                        }
                        rightSection={<IconChevronRight className="nav-chevron" size={15} />}
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

        <Box className="nav-footer">
          <Box className="nav-footer-dot" />
          <Box>
            <Text className="nav-footer-title">CTFinal workspace</Text>
            <Text className="nav-footer-copy">Game 3 inventory tools</Text>
          </Box>
        </Box>
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
            <Paper className="settings-placeholder" withBorder radius="lg" p={{ base: "xl", sm: 42 }}>
              <ThemeIcon size={52} radius={15} variant="light">
                <IconSettings size={27} stroke={1.7} />
              </ThemeIcon>
              <Box>
                <Group gap="sm" mb={6}>
                  <Title order={2}>Settings</Title>
                  <Badge variant="light" radius="xl">Coming soon</Badge>
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
