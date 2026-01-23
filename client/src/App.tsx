import {
  AppShell,
  Burger,
  Group,
  Text,
  Title,
  NavLink,
  ScrollArea,
  Box,
  Badge,
  rem,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBox,
  IconLayoutDashboard,
  IconPackageExport,
  IconSettings,
} from "@tabler/icons-react";
import { useState } from "react";
import { IconHistory } from "@tabler/icons-react";

import { InventoryBinsView } from "./components/InventoryBinsView";
import { CatalogSearchView } from "./components/CatalogSearchView";
import { InventoryBinAssignmentView } from "./components/InventoryBinAssignmentView";

// Existing single-order view (individual CT orders)
import { OrdersView } from "./components/OrdersView";

// NEW weekly grouped Orders view
import { OrdersWeeklyGroupedView } from "./components/OrdersWeeklyGroupedView";

import { ChangeLogsView } from "./components/ChangeLogView";

type Section =
  | "dashboard"
  | "inventory"
  | "bins"
  | "orders"
  | "orders-weekly"
  | "changelogs"
  | "settings";

function App() {
  const [opened, { toggle }] = useDisclosure();
  const [section, setSection] = useState<Section>("dashboard");

  const sectionTitle =
    section === "dashboard"
      ? "CardTrader Catalog"
      : section === "inventory"
      ? "Inventory"
      : section === "bins"
      ? "Inventory Bins"
      : section === "orders"
      ? "Orders"
      : section === "orders-weekly"
      ? "Weekly Shipments"
      : section === "changelogs"
      ? "Change Logs"
      : "Settings";

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      {/* HEADER */}
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Title order={3}>CardTrader Listing Tool</Title>

            <Badge
              ml="xs"
              size="sm"
              variant="light"
              radius="sm"
              style={{ textTransform: "none" }}
            >
              Dashboard: Catalog Search
            </Badge>
          </Group>

          <Text size="sm" c="dimmed">
            {sectionTitle}
          </Text>
        </Group>
      </AppShell.Header>

      {/* NAVBAR */}
      <AppShell.Navbar p="xs">
        <ScrollArea type="auto" style={{ height: "100%" }}>
          {/* MAIN */}
          <Box px="xs" py="sm">
            <Text size="xs" c="dimmed" fw={500} mb={4}>
              MAIN
            </Text>

            <NavLink
              label="Dashboard"
              description="Search CardTrader catalog"
              leftSection={<IconLayoutDashboard size={rem(18)} />}
              active={section === "dashboard"}
              onClick={() => setSection("dashboard")}
            />

            <NavLink
              label="Inventory"
              description="Existing stock & bin locations"
              leftSection={<IconBox size={rem(18)} />}
              active={section === "inventory"}
              onClick={() => setSection("inventory")}
            />

            <NavLink
              label="Inventory Bins"
              description="Your local bin layout"
              leftSection={<IconBox size={rem(18)} />}
              active={section === "bins"}
              onClick={() => setSection("bins")}
            />

            <NavLink
              label="Changelogs"
              description="Sync & inventory history"
              leftSection={<IconHistory size={rem(18)} />}
              active={section === "changelogs"}
              onClick={() => setSection("changelogs")}
            />
          </Box>

          {/* WORKFLOW */}
          <Box px="xs" py="sm">
            <Text size="xs" c="dimmed" fw={500} mb={4}>
              WORKFLOW
            </Text>

            <NavLink
              label="Orders"
              description="Individual CardTrader orders"
              leftSection={<IconPackageExport size={rem(18)} />}
              active={section === "orders"}
              onClick={() => setSection("orders")}
            />

            <NavLink
              label="CardTrader Zero weekly shipments"
              description="Grouped Wednesday → Tuesday view"
              leftSection={<IconPackageExport size={rem(18)} />}
              active={section === "orders-weekly"}
              onClick={() => setSection("orders-weekly")}
            />

            <NavLink
              label="Settings"
              description="API keys, preferences"
              leftSection={<IconSettings size={rem(18)} />}
              active={section === "settings"}
              onClick={() => setSection("settings")}
            />
          </Box>
        </ScrollArea>
      </AppShell.Navbar>

      {/* MAIN CONTENT */}
      <AppShell.Main>
        <Box h="100%" mih="100%">
          {section === "dashboard" && <CatalogSearchView />}
          {section === "inventory" && <InventoryBinAssignmentView />}
          {section === "bins" && <InventoryBinsView />}
          {section === "orders" && <OrdersView />}
          {section === "orders-weekly" && <OrdersWeeklyGroupedView />}
          {section === "changelogs" && <ChangeLogsView />}

          {section === "settings" && (
            <Box>
              <Title order={3} mb="sm">
                Settings (Coming Soon)
              </Title>
              <Text c="dimmed" size="sm">
                Configure CardTrader API token, Mongo connection, and other
                preferences here.
              </Text>
            </Box>
          )}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;
