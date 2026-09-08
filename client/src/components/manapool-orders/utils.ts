import type {
  Buyer,
  OrderAllocation,
  OrderItem,
  OrderSummary,
  ShippingAddress,
} from "./types";

export const HIDDEN_REFUNDED_STORAGE_KEY = "manapool_hidden_refunded_order_ids_v1";

export function getManaPoolLineRawId(it: any, index: number) {
  const raw =
    it?.id ??
    it?.order_item_id ??
    it?.order_line_id ??
    it?.line_id ??
    it?.uuid ??
    it?.seller_order_item_id ??
    null;

  const rawStr = raw == null ? "" : String(raw).trim();

  // Keep this identical to the backend ManaPool reconciler. ManaPool can
  // return 0 / "0" as a repeated, unusable line id, so those lines are
  // identified by their visible position instead.
  return rawStr !== "" && rawStr !== "0" ? rawStr : `line-${index + 1}`;
}

export function getManaPoolNumericOrderItemId(_it: any, index: number) {
  // The backend reconciler intentionally stores orderItemId as 1-based line
  // position. Using ManaPool's raw id here breaks allocation lookup whenever
  // that raw id is numeric or unstable.
  return index + 1;
}

export function getManaPoolMarketplaceOrderItemId(it: any, index: number) {
  return String(getManaPoolLineRawId(it, index));
}

export function getManaPoolInventoryId(it: any) {
  const raw =
    it?.inventory_id ??
    it?.seller_inventory_id ??
    it?.inventory?.id ??
    it?.seller_inventory?.id ??
    it?.inventory_item?.id ??
    it?.inventory?.inventory_id ??
    null;
  return raw == null ? null : String(raw);
}

export function normalizeStatus(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isShippedManaPoolStatus(value?: string | null) {
  return ["shipped", "sent", "fulfilled", "delivered"].includes(
    normalizeStatus(value)
  );
}

export function isRefundedManaPoolStatus(value?: string | null) {
  return normalizeStatus(value).includes("refund");
}

export function getStatusColor(value?: string | null) {
  const status = normalizeStatus(value);
  if (status === "hub_pending") return "yellow";
  if (status === "processing" || status === "in_fulfillment") return "blue";
  if (["sent", "shipped", "fulfilled", "delivered"].includes(status)) return "green";
  if (status.includes("refund") || status === "cancelled" || status === "canceled") {
    return "red";
  }
  return "gray";
}

export function getStatusLabel(value?: string | null) {
  const status = normalizeStatus(value);
  if (status === "processing" || status === "in_fulfillment") return "In fulfillment";
  if (!status) return "Unknown";
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function loadHiddenRefundedOrderIds() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(HIDDEN_REFUNDED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (err) {
    console.error("Failed to load hidden refunded ManaPool order ids", err);
    return new Set<string>();
  }
}

export function persistHiddenRefundedOrderIds(next: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HIDDEN_REFUNDED_STORAGE_KEY,
      JSON.stringify([...next])
    );
  } catch (err) {
    console.error("Failed to save hidden refunded ManaPool order ids", err);
  }
}

export function allocationToBinLocations(allocation?: OrderAllocation | null) {
  if (!allocation?.pickedLocations?.length) return [];
  return allocation.pickedLocations.map((location) => {
    const binValue =
      location.bin && typeof location.bin === "object"
        ? location.bin.label || location.bin.name || location.bin._id || "?"
        : location.bin || "?";
    return {
      bin: String(binValue),
      row: Number(location.row),
      quantity: Number(location.quantity || 0),
    };
  });
}

export function normalizeShippingAddress(order: any): ShippingAddress | null {
  const address =
    order?.shipping_address ||
    order?.shippingAddress ||
    order?.shipping?.address ||
    order?.delivery_address ||
    order?.deliveryAddress ||
    null;
  if (!address) return null;

  const normalized: ShippingAddress = {
    name:
      address.name ||
      address.full_name ||
      address.recipient ||
      order?.buyer?.name ||
      order?.buyer?.username ||
      order?.customer?.name ||
      "",
    line1: address.line1 || address.address1 || address.address_1 || address.street1 || "",
    line2: address.line2 || address.address2 || address.address_2 || address.street2 || "",
    city: address.city || address.locality || "",
    state: address.state || address.province || address.region || "",
    postalCode:
      address.postal_code || address.postalCode || address.zip || address.zip_code || "",
    country: address.country || address.country_code || address.countryCode || "",
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

export function formatShippingAddress(address?: ShippingAddress | null) {
  if (!address) return "";
  const cityLine = [address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return [address.name, address.line1, address.line2, cityLine, address.country]
    .filter(Boolean)
    .join("\n");
}

export function getBuyerDisplay(buyer?: Buyer | null) {
  if (!buyer) return "Unknown";
  if (buyer.username && buyer.country) return `${buyer.username} (${buyer.country})`;
  return buyer.username || buyer.country || "Unknown";
}

export function formatLocalDate(iso?: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTotal(order: OrderSummary) {
  if (order.formattedTotal) return order.formattedTotal;
  if (order.sellerTotalCents != null && order.sellerTotalCurrency) {
    return `${(order.sellerTotalCents / 100).toFixed(2)} ${order.sellerTotalCurrency}`;
  }
  return "-";
}

export function sortOrderItems(items: OrderItem[]) {
  return [...items].sort((a, b) => {
    const aHasBin = !!a.binLocations?.length;
    const bHasBin = !!b.binLocations?.length;
    if (aHasBin && !bHasBin) return -1;
    if (!aHasBin && bHasBin) return 1;
    if (aHasBin && bHasBin) {
      const aLoc = a.binLocations![0];
      const bLoc = b.binLocations![0];
      const binCompare = String(aLoc.bin || "").localeCompare(
        String(bLoc.bin || ""),
        undefined,
        { numeric: true }
      );
      if (binCompare !== 0) return binCompare;
      return (aLoc.row ?? Number.MAX_SAFE_INTEGER) -
        (bLoc.row ?? Number.MAX_SAFE_INTEGER);
    }
    const setCompare = String(a.set_name || "").localeCompare(
      String(b.set_name || ""),
      undefined,
      { numeric: true }
    );
    if (setCompare !== 0) return setCompare;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      numeric: true,
    });
  });
}

export function getCardImageSrc(item: OrderItem) {
  const image = item.imageUrl || item.image_url;
  if (typeof image === "string" && image.startsWith("http")) return image;
  if (item.scryfallId) {
    return `https://api.scryfall.com/cards/${encodeURIComponent(
      item.scryfallId
    )}?format=image&version=normal`;
  }
  return "/card-placeholder.png";
}
