import { OrderAllocation } from "../models/OrderAllocation.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { allocateFromBins } from "../utils/allocateFromBins.js";
import { syncInventoryItemToCardTrader } from "./cardtraderInventorySync.js";

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function getManaPoolOrderId(order) {
  return String(
    order?.id ??
      order?.order_id ??
      order?.number ??
      order?.code ??
      order?.uuid ??
      ""
  );
}

function getManaPoolOrderCode(order) {
  return order?.code
    ? String(order.code)
    : order?.number
    ? String(order.number)
    : order?.id
    ? String(order.id)
    : null;
}

function getManaPoolOrderLines(order) {
  const candidates = [
    asArray(order?.order_items),
    asArray(order?.line_items),
    asArray(order?.items),
    asArray(order?.lines),
    asArray(order?.order_lines),
    asArray(order?.seller_order_items),
    asArray(order?.articles),
    asArray(order?.products),

    // Extra defensive nested shapes
    asArray(order?.data?.order_items),
    asArray(order?.data?.line_items),
    asArray(order?.data?.items),
    asArray(order?.data?.lines),
    asArray(order?.data?.order_lines),
    asArray(order?.data?.seller_order_items),
    asArray(order?.data?.articles),
    asArray(order?.data?.products),
  ];

  // Pick the largest available line array.
  // This prevents ManaPool "items" with only the first card
  // from beating "line_items" with the full order.
  return candidates.reduce((best, current) => {
    return current.length > best.length ? current : best;
  }, []);
}

function getLineStableIds(line, index) {
  const raw =
    line?.id ??
    line?.order_item_id ??
    line?.order_line_id ??
    line?.line_id ??
    line?.uuid ??
    line?.seller_order_item_id ??
    null;

  // ManaPool can return 0 / "0" as a useless repeated line id.
  // Treat that as not stable and fall back to line-1, line-2, etc.
  const rawStr = raw == null ? "" : String(raw).trim();
  const hasStableRaw = rawStr !== "" && rawStr !== "0";

  const marketplaceOrderItemId = hasStableRaw
    ? rawStr
    : `line-${index + 1}`;

  // Always use the visible line position for Mongo's numeric orderItemId.
  // This prevents one bad orderItemId: 0 record from matching every line.
  const orderItemId = index + 1;

  return {
    marketplaceOrderItemId,
    orderItemId,
  };
}

function getLineQuantity(line) {
  const raw =
    line?.quantity ??
    line?.qty ??
    line?.amount ??
    line?.units ??
    line?.count ??
    line?.sold_quantity ??
    line?.quantity_sold ??
    0;

  const qty = Number(raw);
  return Number.isFinite(qty) ? qty : 0;
}

function getLineName(line) {
  return (
    line?.name ||
    line?.product_name ||
    line?.card_name ||
    line?.title ||
    line?.product?.name ||
    line?.product?.card_name ||
    line?.single?.name ||
    line?.single?.card_name ||
    line?.product?.single?.name ||
    line?.product?.single?.card_name ||
    line?.card?.name ||
    "Unknown ManaPool item"
  );
}

function getLineManaPoolInventoryId(line) {
  const raw =
    line?.inventory_id ??
    line?.seller_inventory_id ??
    line?.inventory?.id ??
    line?.seller_inventory?.id ??
    line?.inventory_item?.id ??
    line?.inventory?.inventory_id ??
    null;

  return raw == null ? null : String(raw);
}

function getLineCustomExternalId(line) {
  return (
    line?.custom_external_id ||
    line?.customExternalId ||
    line?.inventory?.custom_external_id ||
    line?.seller_inventory?.custom_external_id ||
    line?.inventory_item?.custom_external_id ||
    line?.product?.custom_external_id ||
    null
  );
}

function getLineScryfallId(line) {
  return (
    line?.scryfall_id ||
    line?.scryfallId ||
    line?.single?.scryfall_id ||
    line?.product?.single?.scryfall_id ||
    line?.product?.scryfall_id ||
    null
  );
}

function getLineConditionId(line) {
  return (
    line?.condition_id ||
    line?.conditionId ||
    line?.single?.condition_id ||
    line?.product?.single?.condition_id ||
    line?.inventory?.condition_id ||
    line?.seller_inventory?.condition_id ||
    null
  );
}

function getLineFinishId(line) {
  return (
    line?.finish_id ||
    line?.finishId ||
    line?.single?.finish_id ||
    line?.product?.single?.finish_id ||
    line?.inventory?.finish_id ||
    line?.seller_inventory?.finish_id ||
    null
  );
}

function getLineLanguageId(line) {
  return (
    line?.language_id ||
    line?.languageId ||
    line?.single?.language_id ||
    line?.product?.single?.language_id ||
    line?.inventory?.language_id ||
    line?.seller_inventory?.language_id ||
    "EN"
  );
}

async function findInventoryItemForManaPoolLine(line) {
  const customExternalId = getLineCustomExternalId(line);
  const manaPoolInventoryId = getLineManaPoolInventoryId(line);

  if (customExternalId) {
    const byCustomExternalId = await InventoryItem.findOne({
      "manapool.customExternalId": customExternalId,
    })
      .populate("locations.bin", "name label rows description")
      .exec();

    if (byCustomExternalId) {
      return {
        inventoryItem: byCustomExternalId,
        matchMethod: "manapool.customExternalId",
        customExternalId,
        manaPoolInventoryId,
      };
    }
  }

  if (manaPoolInventoryId) {
    const byInventoryId = await InventoryItem.findOne({
      "manapool.inventoryId": manaPoolInventoryId,
    })
      .populate("locations.bin", "name label rows description")
      .exec();

    if (byInventoryId) {
      return {
        inventoryItem: byInventoryId,
        matchMethod: "manapool.inventoryId",
        customExternalId,
        manaPoolInventoryId,
      };
    }
  }

  const scryfallId = getLineScryfallId(line);
  const conditionId = getLineConditionId(line);
  const finishId = getLineFinishId(line);
  const languageId = getLineLanguageId(line);

  if (scryfallId && conditionId && finishId) {
    const query = {
      "manapool.scryfallId": scryfallId,
      "manapool.conditionId": conditionId,
      "manapool.finishId": finishId,
    };

    if (languageId) {
      query["manapool.languageId"] = languageId;
    }

    const byManaPoolIdentity = await InventoryItem.findOne(query)
      .populate("locations.bin", "name label rows description")
      .exec();

    if (byManaPoolIdentity) {
      return {
        inventoryItem: byManaPoolIdentity,
        matchMethod: "manapool.scryfallId+conditionId+finishId",
        customExternalId,
        manaPoolInventoryId,
      };
    }
  }

  return {
    inventoryItem: null,
    matchMethod: null,
    customExternalId,
    manaPoolInventoryId,
  };
}

function buildPickedLocationsForSave(pickedLocations) {
  return pickedLocations.map((pl) => ({
    bin: pl.bin?._id || pl.bin,
    row: pl.row,
    quantity: pl.quantity,
  }));
}

function buildPickedLocationsForPreview(pickedLocations) {
  return pickedLocations.map((pl) => ({
    bin: pl.bin?._id?.toString?.() || pl.bin?.toString?.() || pl.bin || null,
    binLabel: pl.bin?.label || pl.bin?.name || null,
    row: pl.row,
    quantity: pl.quantity,
  }));
}

export async function reconcileManaPoolOrder(order, options = {}) {
  const dryRun = options.dryRun === true;
  const livePush = !dryRun && options.livePush !== false;

  const orderId = getManaPoolOrderId(order);
  const orderCode = getManaPoolOrderCode(order);
  const lines = getManaPoolOrderLines(order);

  if (!orderId) {
    return {
      ok: false,
      dryRun,
      error: "missing_manapool_order_id",
      totalLines: lines.length,
    };
  }

  let allocated = 0;
  let skippedExisting = 0;
  let manualReview = 0;
  let failed = 0;

  const failures = [];
  const cardTraderSyncResults = [];
  const dryRunActions = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const { marketplaceOrderItemId, orderItemId } = getLineStableIds(
      line,
      index
    );

    const requestedQty = getLineQuantity(line);
    const name = getLineName(line);

    if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
      failed++;

      failures.push({
        orderItemId,
        marketplaceOrderItemId,
        name,
        reason: "invalid_manapool_order_line_quantity",
      });

      continue;
    }

    const manaPoolInventoryIdForExisting = getLineManaPoolInventoryId(line);

const existingOr = [
  { marketplaceOrderItemId: String(marketplaceOrderItemId) },
];

// Only match by ManaPool inventory id if it exists.
// Do NOT match by orderItemId here, because the old broken allocation used orderItemId: 0.
if (manaPoolInventoryIdForExisting) {
  existingOr.push({
    manapoolInventoryId: String(manaPoolInventoryIdForExisting),
  });
}

const existing = await OrderAllocation.findOne({
  source: "manapool",
  orderId,
  $or: existingOr,
}).lean();

if (existing) {
  skippedExisting++;

  dryRunActions.push({
    action: "skip_existing_allocation",
    orderItemId,
    marketplaceOrderItemId,
    manapoolInventoryId: manaPoolInventoryIdForExisting || null,
    existingAllocationId: existing._id?.toString?.() || null,
  });

  continue;
}

    const {
      inventoryItem: invItem,
      matchMethod,
      customExternalId,
      manaPoolInventoryId,
    } = await findInventoryItemForManaPoolLine(line);

    const currentQuantity = Number(invItem?.totalQuantity || 0);

    const hasUsableStock =
      invItem &&
      Array.isArray(invItem.locations) &&
      invItem.locations.reduce(
        (sum, loc) => sum + Number(loc.quantity || 0),
        0
      ) > 0;

    if (!hasUsableStock) {
      const allocationDoc = {
        source: "manapool",
        inventoryItemId: invItem?._id || null,
        marketplaceOrderItemId,
        manapoolInventoryId: manaPoolInventoryId || null,
        orderId,
        orderCode,
        orderItemId,
        cardTraderId: invItem?.cardTraderId || null,
        requestedQuantity: requestedQty,
        fulfilledQuantity: 0,
        unfilled: requestedQty,
        name,
        condition: invItem?.condition || null,
        isFoil: invItem?.isFoil === true,
        pickedLocations: [],
        picked: false,
        pickedAt: null,
        pickedBy: null,
        status: "manual_review",
        failureReason: matchMethod
          ? "matched_inventory_but_no_usable_stock"
          : "no_safe_manapool_inventory_match",
      };

      if (dryRun) {
        dryRunActions.push({
          action: "would_create_manual_review",
          reason: allocationDoc.failureReason,
          allocation: {
            ...allocationDoc,
            inventoryItemId: invItem?._id?.toString?.() || null,
          },
          matchMethod,
          customExternalId,
          manaPoolInventoryId,
        });
      } else {
        await OrderAllocation.create(allocationDoc);
      }

      manualReview++;

      failures.push({
        orderItemId,
        marketplaceOrderItemId,
        name,
        customExternalId,
        manaPoolInventoryId,
        matchMethod,
        reason: matchMethod
          ? "manual_review_matched_inventory_but_no_usable_stock"
          : "manual_review_no_safe_manapool_inventory_match",
      });

      continue;
    }

    const { pickedLocations, remainingLocations, unfilled } = allocateFromBins(
      invItem.locations || [],
      requestedQty
    );

    const totalPicked = pickedLocations.reduce(
      (sum, loc) => sum + Number(loc.quantity || 0),
      0
    );

    if (totalPicked < requestedQty || !pickedLocations.length) {
      const allocationDoc = {
        source: "manapool",
        inventoryItemId: invItem._id,
        marketplaceOrderItemId,
        manapoolInventoryId: manaPoolInventoryId || null,
        orderId,
        orderCode,
        orderItemId,
        cardTraderId: invItem.cardTraderId || null,
        requestedQuantity: requestedQty,
        fulfilledQuantity: 0,
        unfilled: requestedQty,
        name,
        condition: invItem.condition || null,
        isFoil: invItem.isFoil === true,
        pickedLocations: [],
        picked: false,
        pickedAt: null,
        pickedBy: null,
        status: "manual_review",
        failureReason: "not_enough_exact_stock_to_fully_allocate_line",
      };

      if (dryRun) {
        dryRunActions.push({
          action: "would_create_manual_review",
          reason: allocationDoc.failureReason,
          allocation: {
            ...allocationDoc,
            inventoryItemId: invItem._id?.toString?.() || null,
          },
          inventoryItemId: invItem._id?.toString?.() || null,
          currentQuantity,
          requestedQty,
          totalPicked,
          matchMethod,
          customExternalId,
          manaPoolInventoryId,
        });
      } else {
        await OrderAllocation.create(allocationDoc);
      }

      manualReview++;

      failures.push({
        orderItemId,
        marketplaceOrderItemId,
        name,
        requestedQty,
        totalPicked,
        customExternalId,
        manaPoolInventoryId,
        matchMethod,
        reason: "manual_review_not_enough_exact_stock_to_fully_allocate_line",
      });

      continue;
    }

    const newQuantity = Math.max(0, currentQuantity - totalPicked);

    const allocationDoc = {
      source: "manapool",
      inventoryItemId: invItem._id,
      marketplaceOrderItemId,
      manapoolInventoryId: manaPoolInventoryId || null,
      orderId,
      orderCode,
      orderItemId,
      cardTraderId: invItem.cardTraderId || null,
      requestedQuantity: requestedQty,
      fulfilledQuantity: totalPicked,
      unfilled,
      name: name || invItem.name || "Unknown ManaPool item",
      condition: invItem.condition || null,
      isFoil: invItem.isFoil === true,
      pickedLocations: buildPickedLocationsForSave(pickedLocations),
      picked: false,
      pickedAt: null,
      pickedBy: null,
      status: "allocated",
      failureReason: null,
    };

    if (dryRun) {
      dryRunActions.push({
        action: "would_allocate_deduct_and_sync_cardtrader",
        inventoryItemId: invItem._id?.toString?.() || null,
        cardTraderId: invItem.cardTraderId || null,
        manapoolInventoryId: manaPoolInventoryId || null,
        customExternalId,
        matchMethod,
        currentQuantity,
        requestedQty,
        totalPicked,
        newQuantity,
        pickedLocations: buildPickedLocationsForPreview(pickedLocations),
        remainingLocationsPreview: buildPickedLocationsForPreview(
          remainingLocations
        ),
        allocation: {
          ...allocationDoc,
          inventoryItemId: invItem._id?.toString?.() || null,
        },
      });

      allocated++;
      continue;
    }

    invItem.locations = remainingLocations;
    invItem.totalQuantity = newQuantity;

    await invItem.save();

    let cardTraderResult = null;

    try {
      cardTraderResult = await syncInventoryItemToCardTrader(invItem, {
        livePush,
      });

      cardTraderSyncResults.push({
        orderItemId,
        marketplaceOrderItemId,
        inventoryItemId: invItem._id?.toString?.(),
        cardTraderId: invItem.cardTraderId || null,
        newQuantity: invItem.totalQuantity,
        result: cardTraderResult,
      });

      if (!cardTraderResult?.ok || cardTraderResult?.synced === 0) {
        invItem.manapool = invItem.manapool || {};
        invItem.manapool.lastSyncError = JSON.stringify({
          source: "manapool_sale_cardtrader_fanout",
          orderId,
          orderItemId,
          marketplaceOrderItemId,
          cardTraderId: invItem.cardTraderId || null,
          newQuantity: invItem.totalQuantity,
          result: cardTraderResult,
        });

        await invItem.save();
      }
    } catch (syncErr) {
      cardTraderResult = {
        ok: false,
        error: syncErr?.response?.data || syncErr?.message || syncErr,
      };

      cardTraderSyncResults.push({
        orderItemId,
        marketplaceOrderItemId,
        inventoryItemId: invItem._id?.toString?.(),
        cardTraderId: invItem.cardTraderId || null,
        newQuantity: invItem.totalQuantity,
        result: cardTraderResult,
      });

      invItem.manapool = invItem.manapool || {};
      invItem.manapool.lastSyncError =
        typeof cardTraderResult.error === "string"
          ? cardTraderResult.error
          : JSON.stringify(cardTraderResult.error);

      await invItem.save();
    }

    await OrderAllocation.create(allocationDoc);

    allocated++;
  }

  return {
    ok: true,
    dryRun,
    source: "manapool",
    orderId,
    orderCode,
    totalLines: lines.length,
    allocated,
    skippedExisting,
    manualReview,
    failed,
    failures,
    cardTraderSyncResults,
    dryRunActions,
  };
}