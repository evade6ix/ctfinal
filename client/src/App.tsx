import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  AppShell,
  Avatar,
  Badge,
  Box,
  Burger,
  Divider,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  rem,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconActivity,
  IconAlertTriangle,
  IconBox,
  IconBuildingWarehouse,
  IconCards,
  IconChartBar,
  IconDashboard,
  IconHistory,
  IconPackageExport,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
} from "@tabler/icons-react";

const OperationsDashboard = lazy(() => import("./components/OperationsDashboard").then((module) => ({ default: module.OperationsDashboard })));
const CatalogSearchView = lazy(() => import("./components/CatalogSearchView").then((module) => ({ default: module.CatalogSearchView })));
const CardListView = lazy(() => import("./components/CardListView").then((module) => ({ default: module.CardListView })));
const InventoryBinAssignmentView = lazy(() => import("./components/InventoryBinAssignmentView").then((module) => ({ default: module.InventoryBinAssignmentView })));
const InventoryBinsView = lazy(() => import("./components/InventoryBinsView").then((module) => ({ default: module.InventoryBinsView })));
const CardTraderRepriceView = lazy(() => import("./components/CardTraderRepriceView").then((module) => ({ default: module.CardTraderRepriceView })));
const OrdersView = lazy(() => import("./components/OrdersView").then((module) => ({ default: module.OrdersView })));
const OrdersWeeklyGroupedView = lazy(() => import("./components/OrdersWeeklyGroupedView").then((module) => ({ default: module.OrdersWeeklyGroupedView })));
const ChangeLogsView = lazy(() => import("./components/ChangeLogView").then((module) => ({ default: module.ChangeLogsView })));
const ManualAssignmentsView = lazy(() => import("./components/ManualAssignmentsView").then((module) => ({ default: module.ManualAssignmentsView })));
const UnifiedPickingView = lazy(() => import("./components/UnifiedPickingView").then((module) => ({ default: module.UnifiedPickingView })));
const InventoryIntegrityView = lazy(() => import("./components/InventoryIntegrityView").then((module) => ({ default: module.InventoryIntegrityView })));
const OperationHistoryView = lazy(() => import("./components/OperationHistoryView").then((module) => ({ default: module.OperationHistoryView })));
const SettingsView = lazy(() => import("./components/SettingsView").then((module) => ({ default: module.SettingsView })));

type Section =
  | "overview"
  | "catalog"
  | "picking"
  | "orders"
  | "orders-weekly"
  | "manual-assignments"
  | "card-list"
  | "inventory"
  | "bins"
  | "integrity"
  | "repricer"
  | "operations"
  | "changelogs"
  | "settings";

const routeBySection: Record<Section, string> = {
  overview: "/",
  catalog: "/catalog",
  picking: "/picking",
  orders: "/orders",
  "orders-weekly": "/weekly-shipments",
  "manual-assignments": "/exceptions",
  "card-list": "/card-list",
  inventory: "/inventory",
  bins: "/bins",
  integrity: "/integrity",
  repricer: "/repricer",
  operations: "/operations",
  changelogs: "/changelogs",
  settings: "/settings",
};

const sectionByRoute = Object.fromEntries(
  Object.entries(routeBySection).map(([section, route]) => [route, section])
) as Record<string, Section>;

const navigation = [
  {
    label: "OPERATIONS",
    items: [
      { section: "overview" as const, label: "Overview", description: "Live command centre", icon: IconDashboard },
      { section: "picking" as const, label: "Pick route", description: "Unified fulfillment queue", icon: IconBuildingWarehouse },
      { section: "orders" as const, label: "Orders", description: "ManaPool and daily sales", icon: IconPackageExport },
      { section: "orders-weekly" as const, label: "Weekly shipments", description: "CardTrader Zero route", icon: IconChartBar },
      { section: "manual-assignments" as const, label: "Exceptions", description: "Unassigned order lines", icon: IconAlertTriangle },
    ],
  },
  {
    label: "INVENTORY",
    items: [
      { section: "catalog" as const, label: "Catalog & staging", description: "Create marketplace listings", icon: IconSparkles },
      { section: "card-list" as const, label: "Card list", description: "Browse visual inventory", icon: IconCards },
      { section: "inventory" as const, label: "Inventory locations", description: "Assign stock to bins", icon: IconBox },
      { section: "bins" as const, label: "Bins", description: "Physical layout", icon: IconBuildingWarehouse },
      { section: "integrity" as const, label: "Integrity centre", description: "Audit totals and locations", icon: IconShieldCheck },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { section: "repricer" as const, label: "CardTrader repricer", description: "Preview and apply pricing", icon: IconRefresh },
      { section: "operations" as const, label: "Operation history", description: "Durable job audit trail", icon: IconActivity },
      { section: "changelogs" as const, label: "Change logs", description: "Inventory event history", icon: IconHistory },
      { section: "settings" as const, label: "Settings", description: "Staff and system status", icon: IconSettings },
    ],
  },
];

function getInitialSection(): Section {
  const normalized = window.location.pathname.replace(/\/+$/, "") || "/";
  return sectionByRoute[normalized] || "overview";
}

function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const [section, setSection] = useState<Section>(getInitialSection);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [staffName, setStaffName] = useState(() => window.localStorage.getItem("ctfinal_staff_name") || "Local staff");

  useEffect(() => {
    const onPopState = () => setSection(getInitialSection());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/health");
        if (active) setServerOnline(response.ok);
      } catch {
        if (active) setServerOnline(false);
      }
    };
    check();
    const timer = window.setInterval(check, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const navigate = (next: string) => {
    const target = (next in routeBySection ? next : "overview") as Section;
    setSection(target);
    const path = routeBySection[target];
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    close();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveStaffName = (value: string) => {
    setStaffName(value);
    window.localStorage.setItem("ctfinal_staff_name", value);
  };

  const title = useMemo(() => {
    for (const group of navigation) {
      const item = group.items.find((entry) => entry.section === section);
      if (item) return item.label;
    }
    return "CTFinal";
  }, [section]);

  const content = (() => {
    switch (section) {
      case "overview": return <OperationsDashboard onNavigate={navigate} />;
      case "catalog": return <CatalogSearchView />;
      case "picking": return <UnifiedPickingView staffName={staffName} />;
      case "orders": return <OrdersView />;
      case "orders-weekly": return <OrdersWeeklyGroupedView />;
      case "manual-assignments": return <ManualAssignmentsView />;
      case "card-list": return <CardListView />;
      case "inventory": return <InventoryBinAssignmentView />;
      case "bins": return <InventoryBinsView />;
      case "integrity": return <InventoryIntegrityView />;
      case "repricer": return <CardTraderRepriceView />;
      case "operations": return <OperationHistoryView />;
      case "changelogs": return <ChangeLogsView />;
      case "settings": return <SettingsView staffName={staffName} onStaffNameChange={saveStaffName} />;
    }
  })();

  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 294, breakpoint: "md", collapsed: { mobile: !opened } }}
      padding={0}
      className="ct-shell"
    >
      <AppShell.Header className="ct-header">
        <Group h="100%" px={{ base: "md", md: "xl" }} justify="space-between" wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="md" size="sm" />
            <Group gap="sm" wrap="nowrap" className="brand-lockup">
              <ThemeIcon className="brand-mark" size={42} radius="md">
                <IconSparkles size={22} stroke={2.2} />
              </ThemeIcon>
              <div>
                <Text fw={900} size="lg" lh={1}>CTFinal</Text>
                <Text size="xs" c="dimmed" mt={4}>Marketplace operations</Text>
              </div>
            </Group>
          </Group>

          <TextInput
            visibleFrom="sm"
            className="global-search"
            w="min(38vw, 480px)"
            placeholder="Search inventory…"
            value={globalSearch}
            onChange={(event) => setGlobalSearch(event.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            rightSection={<Badge size="xs" variant="light">Enter</Badge>}
            onKeyDown={(event) => {
              if (event.key === "Enter" && globalSearch.trim()) {
                window.localStorage.setItem("ctfinal_global_search", globalSearch.trim());
                navigate("card-list");
              }
            }}
          />

          <Group gap="md" wrap="nowrap">
            <Tooltip label={serverOnline === null ? "Checking server" : serverOnline ? "All core services reachable" : "Server unavailable"}>
              <Badge
                variant="light"
                color={serverOnline === null ? "gray" : serverOnline ? "teal" : "red"}
                leftSection={<span className={`status-dot ${serverOnline ? "status-dot--ok" : serverOnline === false ? "status-dot--bad" : ""}`} />}
                visibleFrom="sm"
              >
                {serverOnline === null ? "Checking" : serverOnline ? "Live" : "Offline"}
              </Badge>
            </Tooltip>
            <Avatar radius="xl" color="yellow" size={38}>{staffName.slice(0, 2).toUpperCase()}</Avatar>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="ct-navbar" p="md">
        <ScrollArea type="auto" style={{ height: "100%" }} scrollbarSize={6}>
          <Group justify="space-between" px="xs" mb="md">
            <Text size="xs" c="dimmed">CURRENT VIEW</Text>
            <Badge variant="dot" color="yellow" size="sm">{title}</Badge>
          </Group>
          {navigation.map((group, groupIndex) => (
            <Box key={group.label} mb="lg">
              {groupIndex > 0 && <Divider mb="lg" color="rgba(255,255,255,.06)" />}
              <Text className="nav-section-label" px="xs" mb={7}>{group.label}</Text>
              {group.items.map((item) => (
                <NavLink
                  key={item.section}
                  label={item.label}
                  description={item.description}
                  leftSection={<item.icon size={rem(18)} stroke={1.8} />}
                  active={section === item.section}
                  onClick={() => navigate(item.section)}
                  className="ct-nav-link"
                  color="yellow"
                />
              ))}
            </Box>
          ))}
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main className="ct-main">
        <Box className="ct-content">
          <Suspense fallback={<Group justify="center" py={120}><Loader color="yellow" /></Group>}>
            {content}
          </Suspense>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;
