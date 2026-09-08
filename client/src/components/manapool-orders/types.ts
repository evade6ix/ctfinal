export type Buyer = {
  username?: string;
  country?: string;
  [key: string]: any;
};

export type ShippingAddress = {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export type OrderSummary = {
  id: number | string;
  code?: string;
  state?: string;
  orderAs?: string;
  buyer?: Buyer | null;
  size?: number;
  createdAt?: string | null;
  sellerTotalCents?: number | null;
  sellerTotalCurrency?: string | null;
  formattedTotal?: string | null;
  allocated?: boolean;
};

export type OrderDetails = {
  shippingAddress?: ShippingAddress | null;
  status?: string | null;
  shippingMethod?: string | null;
};

export type OrderItem = {
  id?: number | string;
  marketplaceOrderItemId?: string;
  cardTraderId?: number | null;
  manapoolInventoryId?: string | null;
  name?: string;
  quantity?: number;
  image_url?: string;
  imageUrl?: string;
  setCode?: string | null;
  set_name?: string;
  collectorNumber?: string | null;
  scryfallId?: string | null;
  tcgplayerSkuId?: string | null;
  manapoolCustomExternalId?: string | null;
  binLocations?: { bin: string; row: number; quantity: number }[];
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  source?: "manapool" | "cardtrader";
  isFoil?: boolean;
  condition?: string | null;
};

export type OrderAllocation = {
  _id?: string;
  source?: "manapool" | "cardtrader";
  orderId?: string;
  orderItemId?: number;
  marketplaceOrderItemId?: string | null;
  cardTraderId?: number | null;
  manapoolInventoryId?: string | null;
  inventoryItem?: {
    _id?: string;
    name?: string | null;
    setCode?: string | null;
    cardTraderId?: number | null;
    condition?: string | null;
    isFoil?: boolean;
    imageUrl?: string | null;
    identifiers?: {
      scryfallId?: string | null;
      tcgplayerSkuId?: string | null;
    };
    manapool?: {
      tcgplayerSku?: string | null;
      scryfallId?: string | null;
      customExternalId?: string | null;
    };
  } | null;
  setCode?: string | null;
  scryfallId?: string | null;
  tcgplayerSkuId?: string | null;
  manapoolCustomExternalId?: string | null;
  requestedQuantity?: number;
  name?: string;
  condition?: string | null;
  isFoil?: boolean;
  picked?: boolean;
  pickedAt?: string | null;
  pickedBy?: string | null;
  pickedLocations?: {
    bin?: any;
    row?: number;
    quantity?: number;
  }[];
};
