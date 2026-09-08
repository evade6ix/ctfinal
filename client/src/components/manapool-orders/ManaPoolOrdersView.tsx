import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconArrowsDownUp, IconTrash } from "@tabler/icons-react";

import { OrdersDailyView } from "../OrdersDailyView";
import { ManaPoolOrderPanel } from "./ManaPoolOrderPanel";
import { useManaPoolOrders } from "./useManaPoolOrders";
import {
  formatLocalDate,
  formatTotal,
  getBuyerDisplay,
  getStatusColor,
  getStatusLabel,
  isRefundedManaPoolStatus,
} from "./utils";

export function ManaPoolOrdersView() {
  const model = useManaPoolOrders();
  const {
    visibleOrders,
    selectedOrderId,
    loading,
    error,
    viewMode,
    setViewMode,
    syncing,
    syncMessage,
    syncError,
    hiddenRefundedOrderIds,
    fetchOrders,
    selectOrder,
    hideRefundedOrder,
    clearHiddenRefundedOrders,
    syncOrders,
  } = model;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Orders</Title>
          <Text c="dimmed" size="sm">
            Mana Pool seller orders. Select an order to open the fulfillment workspace.
          </Text>
        </div>

        <Group gap="xs">
          <SegmentedControl
            size="sm"
            value={viewMode}
            onChange={(value) => setViewMode(value as "orders" | "daily")}
            data={[
              { label: "Orders", value: "orders" },
              { label: "Daily sales", value: "daily" },
            ]}
          />
          <Button onClick={fetchOrders} loading={loading} variant="light">
            Refresh
          </Button>
          {hiddenRefundedOrderIds.size > 0 && (
            <Button size="sm" variant="subtle" onClick={clearHiddenRefundedOrders}>
              Show hidden refunds ({hiddenRefundedOrderIds.size})
            </Button>
          )}
          <Button
            leftSection={<IconArrowsDownUp size={16} />}
            onClick={syncOrders}
            loading={syncing}
            variant="filled"
            color="red"
          >
            Run Safe Sync
          </Button>
        </Group>
      </Group>

      {error && (
        <Paper p="sm" withBorder>
          <Text c="red">{error}</Text>
        </Paper>
      )}
      {syncMessage && (
        <Paper p="sm" withBorder>
          <Text c="teal">{syncMessage}</Text>
        </Paper>
      )}
      {syncError && (
        <Paper p="sm" withBorder>
          <Text c="red">{syncError}</Text>
        </Paper>
      )}

      {viewMode === "orders" && (
        <Box
          style={{
            display: "grid",
            gridTemplateColumns:
              selectedOrderId != null
                ? "minmax(0, 1fr) minmax(390px, 460px)"
                : "minmax(0, 1fr)",
            gap: 16,
            alignItems: "stretch",
          }}
        >
          <Paper withBorder radius="md" p={0} style={{ minWidth: 0 }}>
            <ScrollArea h={620}>
              <Table highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Code</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Buyer</Table.Th>
                    <Table.Th>Items</Table.Th>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Total</Table.Th>
                    <Table.Th></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {!loading && visibleOrders.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={7} ta="center">
                        <Text c="dimmed">No Mana Pool orders found.</Text>
                      </Table.Td>
                    </Table.Tr>
                  )}

                  {visibleOrders.map((order) => {
                    const refunded = isRefundedManaPoolStatus(order.state);
                    const selected = String(selectedOrderId) === String(order.id);
                    return (
                      <Table.Tr
                        key={order.id}
                        onClick={() => selectOrder(order.id)}
                        style={{
                          cursor: "pointer",
                          background: selected ? "var(--mantine-color-blue-0)" : undefined,
                        }}
                      >
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Box>
                              <Text fw={600}>{order.code}</Text>
                              <Text size="xs" c="dimmed">
                                Mana Pool
                              </Text>
                            </Box>
                            {order.allocated && (
                              <Badge size="xs" color="yellow" variant="filled">
                                Allocated
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Badge color={getStatusColor(order.state)} variant="light">
                            {getStatusLabel(order.state)}
                          </Badge>
                        </Table.Td>
                        <Table.Td>{getBuyerDisplay(order.buyer)}</Table.Td>
                        <Table.Td>{order.size ?? "-"}</Table.Td>
                        <Table.Td>{formatLocalDate(order.createdAt)}</Table.Td>
                        <Table.Td>{formatTotal(order)}</Table.Td>
                        <Table.Td>
                          <Group gap={6} justify="flex-end" wrap="nowrap">
                            {refunded && (
                              <Tooltip label="Hide refunded order from this view">
                                <ActionIcon
                                  size="sm"
                                  variant="light"
                                  color="red"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    hideRefundedOrder(order.id);
                                  }}
                                >
                                  <IconTrash size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            <Button
                              size="xs"
                              variant={selected ? "filled" : "light"}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectOrder(order.id);
                              }}
                            >
                              {selected ? "Open" : "View"}
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Paper>

          <ManaPoolOrderPanel model={model} />
        </Box>
      )}

      {viewMode === "daily" && <OrdersDailyView />}
    </Stack>
  );
}
