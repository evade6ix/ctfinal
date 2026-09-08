import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconCheck,
  IconCopy,
  IconTruckDelivery,
  IconX,
} from "@tabler/icons-react";

import type { ManaPoolOrdersModel } from "./useManaPoolOrders";
import {
  formatShippingAddress,
  getCardImageSrc,
  getStatusColor,
  getStatusLabel,
  isShippedManaPoolStatus,
  normalizeStatus,
  sortOrderItems,
} from "./utils";

type Props = {
  model: ManaPoolOrdersModel;
};

type CardImagePreviewProps = {
  src: string;
  alt: string;
};

function handleCardImageError(event: React.SyntheticEvent<HTMLImageElement>) {
  const target = event.currentTarget;
  if (!target.src.endsWith("/card-placeholder.png")) {
    target.src = "/card-placeholder.png";
  }
}

function CardImagePreview({ src, alt }: CardImagePreviewProps) {
  return (
    <Tooltip
      position="left"
      openDelay={80}
      closeDelay={60}
      withinPortal
      offset={14}
      label={
        <img
          src={src}
          alt={`${alt} enlarged`}
          width={294}
          height={410}
          style={{
            display: "block",
            width: 294,
            height: "auto",
            maxHeight: 410,
            objectFit: "contain",
            borderRadius: 8,
            background: "var(--mantine-color-gray-1)",
          }}
          onError={handleCardImageError}
        />
      }
      styles={{
        tooltip: {
          padding: 8,
          background: "#ffffff",
          border: "1px solid var(--mantine-color-gray-3)",
          borderRadius: 10,
          boxShadow: "0 18px 45px rgba(0, 0, 0, 0.22)",
          maxWidth: 312,
        },
      }}
    >
      <img
        src={src}
        alt={alt}
        width={72}
        height={100}
        style={{
          display: "block",
          objectFit: "cover",
          borderRadius: 6,
          flexShrink: 0,
          background: "var(--mantine-color-gray-1)",
          cursor: "zoom-in",
        }}
        onError={handleCardImageError}
      />
    </Tooltip>
  );
}

export function ManaPoolOrderPanel({ model }: Props) {
  const {
    selectedOrderId,
    selectedOrder,
    itemsByOrder,
    detailsByOrder,
    loadingOrderId,
    pickedMap,
    fulfillmentAction,
    actionMessage,
    actionError,
    closeOrder,
    togglePicked,
    copyShippingAddress,
    setFulfillmentStatus,
  } = model;

  if (selectedOrderId == null) return null;

  const detail = detailsByOrder[selectedOrderId];
  const items = itemsByOrder[selectedOrderId];
  const shippingAddressText = formatShippingAddress(detail?.shippingAddress);
  const status = detail?.status || selectedOrder?.state;
  const isProcessing = normalizeStatus(status) === "processing";
  const isLoading =
    loadingOrderId != null && String(loadingOrderId) === String(selectedOrderId);

  return (
    <Paper
      withBorder
      radius="md"
      p={0}
      style={{ minWidth: 0, background: "#ffffff", overflow: "hidden" }}
    >
      <Stack gap={0} h={620}>
        <Box p="md" style={{ borderBottom: "1px solid var(--mantine-color-gray-2)" }}>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Mana Pool order
              </Text>
              <Title order={3}>{selectedOrder?.code || selectedOrderId}</Title>
              <Group gap={6} mt={8}>
                <Badge color={getStatusColor(status)} variant="light">
                  {getStatusLabel(status)}
                </Badge>
                {selectedOrder?.size != null && (
                  <Badge color="gray" variant="light">
                    {selectedOrder.size} item{selectedOrder.size === 1 ? "" : "s"}
                  </Badge>
                )}
              </Group>
            </Box>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={closeOrder}
              aria-label="Close order details"
            >
              <IconX size={18} />
            </ActionIcon>
          </Group>
        </Box>

        <ScrollArea style={{ flex: 1 }}>
          <Stack gap="md" p="md">
            {isLoading && !items && (
              <Group justify="center" p="xl">
                <Loader size="sm" />
              </Group>
            )}

            {actionMessage && (
              <Paper p="sm" radius="md" bg="teal.0">
                <Text size="sm" c="teal.8">
                  {actionMessage}
                </Text>
              </Paper>
            )}

            {actionError && (
              <Paper p="sm" radius="md" bg="red.0">
                <Text size="sm" c="red.8">
                  {actionError}
                </Text>
              </Paper>
            )}

            <Box>
              <Group justify="space-between" mb={8}>
                <Text fw={700}>Ship to</Text>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconCopy size={14} />}
                  disabled={!shippingAddressText}
                  onClick={() => copyShippingAddress(detail?.shippingAddress)}
                >
                  Copy address
                </Button>
              </Group>
              <Paper withBorder radius="md" p="sm" bg="gray.0">
                {shippingAddressText ? (
                  <Text size="sm" style={{ whiteSpace: "pre-line", lineHeight: 1.6 }}>
                    {shippingAddressText}
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    No shipping address returned for this order.
                  </Text>
                )}
              </Paper>
              {detail?.shippingMethod && (
                <Text size="xs" c="dimmed" mt={6}>
                  Shipping method: {detail.shippingMethod}
                </Text>
              )}
            </Box>

            <Box>
              <Text fw={700} mb={8}>
                Fulfillment
              </Text>
              <Group grow align="stretch">
                <Button
                  variant={isProcessing ? "light" : "outline"}
                  color="blue"
                  leftSection={<IconCheck size={16} />}
                  disabled={isProcessing || isShippedManaPoolStatus(status)}
                  loading={fulfillmentAction === "processing"}
                  onClick={() => setFulfillmentStatus(selectedOrderId, "processing")}
                >
                  {isProcessing ? "In fulfillment" : "Mark in fulfillment"}
                </Button>
                <Button
                  color="green"
                  leftSection={<IconTruckDelivery size={16} />}
                  disabled={isShippedManaPoolStatus(status)}
                  loading={fulfillmentAction === "shipped"}
                  onClick={() => setFulfillmentStatus(selectedOrderId, "shipped")}
                >
                  Mark shipped
                </Button>
              </Group>
            </Box>

            <Divider />

            <Box>
              <Group justify="space-between" mb="sm">
                <Text fw={700}>Cards</Text>
                {items && (
                  <Text size="xs" c="dimmed">
                    {items.reduce((sum, item) => sum + Number(item.quantity || 1), 0)} total
                  </Text>
                )}
              </Group>

              {items?.length === 0 && (
                <Text c="dimmed" ta="center" py="lg">
                  No line items found.
                </Text>
              )}

              {!!items?.length && (
                <Stack gap="sm">
                  {sortOrderItems(items).map((item, index) => {
                    const cardTraderId =
                      typeof item.cardTraderId === "number" ? item.cardTraderId : undefined;
                    const pickedKey = typeof item.id === "number" ? item.id : cardTraderId;
                    const isPicked =
                      pickedKey !== undefined
                        ? !!pickedMap[selectedOrderId]?.[pickedKey]
                        : !!item.picked;
                    const cardImageSrc = getCardImageSrc(item);

                    return (
                      <Paper
                        key={`${item.marketplaceOrderItemId || item.id || index}`}
                        withBorder
                        radius="md"
                        p="sm"
                      >
                        <Group align="flex-start" wrap="nowrap">
                          <CardImagePreview
                            src={cardImageSrc}
                            alt={item.name || "Card"}
                          />

                          <Box style={{ flex: 1, minWidth: 0 }}>
                            <Text fw={600} lineClamp={2}>
                              {item.name || "No name"}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {item.set_name || item.setCode || "Unknown set"}
                            </Text>

                            <Group gap={6} mt={7}>
                              <Badge
                                size="sm"
                                color={item.isFoil ? "yellow" : "gray"}
                                variant="light"
                              >
                                {item.isFoil ? "Foil" : "Non-Foil"}
                              </Badge>
                              {item.condition && (
                                <Badge size="sm" variant="light" color="blue">
                                  {item.condition}
                                </Badge>
                              )}
                              <Badge size="sm" variant="light" color="gray">
                                Qty {item.quantity ?? "?"}
                              </Badge>
                            </Group>

                            <Group gap={6} mt={7}>
                              {item.binLocations?.length ? (
                                item.binLocations.map((location, i) => (
                                  <Badge key={i} color="yellow" variant="light">
                                    {location.bin ?? "?"} / Row {location.row ?? "?"} (x
                                    {location.quantity ?? "?"})
                                  </Badge>
                                ))
                              ) : (
                                <Badge color="red" variant="light">
                                  Unassigned
                                </Badge>
                              )}
                            </Group>

                            <Button
                              mt="sm"
                              size="xs"
                              variant={isPicked ? "light" : "outline"}
                              color={isPicked ? "green" : "gray"}
                              disabled={cardTraderId == null}
                              onClick={() => togglePicked(selectedOrderId, item)}
                            >
                              {isPicked ? "Picked" : "Mark picked"}
                            </Button>
                          </Box>
                        </Group>
                      </Paper>
                    );
                  })}
                </Stack>
              )}
            </Box>
          </Stack>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}
