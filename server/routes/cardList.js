import express from "express";
import { InventoryItem } from "../models/InventoryItem.js";
import { CatalogSetCache } from "../models/CatalogSetCache.js";

const router = express.Router();

function cleanText(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedString(value) {
  return cleanText(value).toLocaleLowerCase();
}

function compareText(a, b) {
  return cleanText(a).localeCompare(cleanText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function buildCatalogMetadataMap(cacheDocs) {
  const metadataByBlueprintId = new Map();

  for (const cache of cacheDocs) {
    const blueprints = Array.isArray(cache.blueprints) ? cache.blueprints : [];

    for (const blueprint of blueprints) {
      const blueprintId = Number(blueprint?.id);
      if (!Number.isFinite(blueprintId) || blueprintId <= 0) continue;

      metadataByBlueprintId.set(blueprintId, {
        name: cleanText(blueprint?.name),
        setCode: cleanText(blueprint?.setCode || cache.setCode),
        setName: cleanText(blueprint?.setName || cache.setName),
        rarity: cleanText(blueprint?.rarity),
        collectorNumber: cleanText(
          blueprint?.collectorNumber || blueprint?.number
        ),
        imageUrl: cleanText(
          blueprint?.imageUrl || blueprint?.image_url || blueprint?.image
        ),
      });
    }
  }

  return metadataByBlueprintId;
}

function buildSetOptions(items) {
  const byCode = new Map();

  for (const item of items) {
    const setCode = cleanText(item.setCode);
    if (!setCode) continue;

    const setName = cleanText(item.setName);
    if (!byCode.has(setCode)) {
      byCode.set(setCode, {
        value: setCode,
        label: setName ? `${setCode} – ${setName}` : setCode,
      });
    }
  }

  return [...byCode.values()].sort((a, b) => compareText(a.label, b.label));
}

router.get("/", async (req, res) => {
  try {
    const requestedPage = Math.max(1, Math.floor(finiteNumber(req.query.page, 1)));
    const pageSize = Math.min(
      100,
      Math.max(1, Math.floor(finiteNumber(req.query.pageSize, 10)))
    );

    const search = normalizedString(req.query.search);
    const setCode = cleanText(req.query.setCode);
    const condition = cleanText(req.query.condition);
    const rarity = cleanText(req.query.rarity);
    const game = cleanText(req.query.game);
    const foil = cleanText(req.query.foil).toLowerCase();
    const sort = cleanText(req.query.sort) || "quantity_desc";
    const includeZero = cleanText(req.query.includeZero).toLowerCase() === "true";

    const inventoryFilter = includeZero
      ? {}
      : {
          totalQuantity: { $gt: 0 },
        };

    const inventoryItems = await InventoryItem.find(inventoryFilter)
      .populate("locations.bin", "name label rows description")
      .lean();

    const blueprintIds = [
      ...new Set(
        inventoryItems
          .map((item) => Number(item.blueprintId))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];

    const setCodes = [
      ...new Set(
        inventoryItems.map((item) => cleanText(item.setCode)).filter(Boolean)
      ),
    ];

    const cacheFilters = [];
    if (setCodes.length) cacheFilters.push({ setCode: { $in: setCodes } });
    if (blueprintIds.length) {
      cacheFilters.push({ "blueprints.id": { $in: blueprintIds } });
    }

    const cacheDocs = cacheFilters.length
      ? await CatalogSetCache.find({ $or: cacheFilters })
          .select("setCode setName blueprints")
          .lean()
      : [];

    const metadataByBlueprintId = buildCatalogMetadataMap(cacheDocs);

    const enrichedItems = inventoryItems.map((item) => {
      const blueprintId = Number(item.blueprintId);
      const metadata = Number.isFinite(blueprintId)
        ? metadataByBlueprintId.get(blueprintId)
        : null;

      const locations = Array.isArray(item.locations) ? item.locations : [];
      const totalQuantity = Math.max(0, finiteNumber(item.totalQuantity));
      const assignedQuantity = locations.reduce(
        (sum, location) => sum + Math.max(0, finiteNumber(location?.quantity)),
        0
      );

      return {
        ...item,
        name: cleanText(item.name || metadata?.name) || "Unknown card",
        setCode: cleanText(item.setCode || metadata?.setCode),
        setName: cleanText(item.setName || metadata?.setName),
        rarity: cleanText(item.rarity || metadata?.rarity),
        collectorNumber: cleanText(
          item.collectorNumber || metadata?.collectorNumber
        ),
        imageUrl:
          cleanText(item.imageUrl || metadata?.imageUrl) || null,
        totalQuantity,
        assignedQuantity,
        unassignedQuantity: Math.max(0, totalQuantity - assignedQuantity),
        locations,
      };
    });

    const filterOptions = {
      sets: buildSetOptions(enrichedItems),
      conditions: [
        ...new Set(
          enrichedItems.map((item) => cleanText(item.condition)).filter(Boolean)
        ),
      ].sort(compareText),
      rarities: [
        ...new Set(
          enrichedItems.map((item) => cleanText(item.rarity)).filter(Boolean)
        ),
      ].sort(compareText),
      games: [
        ...new Set(
          enrichedItems.map((item) => cleanText(item.game)).filter(Boolean)
        ),
      ].sort(compareText),
    };

    const filteredItems = enrichedItems.filter((item) => {
      if (setCode && cleanText(item.setCode) !== setCode) return false;
      if (condition && cleanText(item.condition) !== condition) return false;
      if (rarity && cleanText(item.rarity) !== rarity) return false;
      if (game && cleanText(item.game) !== game) return false;
      if (foil === "foil" && item.isFoil !== true) return false;
      if (foil === "nonfoil" && item.isFoil === true) return false;

      if (!search) return true;

      const haystack = [
        item.name,
        item.setCode,
        item.setName,
        item.rarity,
        item.collectorNumber,
        item.game,
        item.condition,
        item.cardTraderId,
        item.blueprintId,
      ]
        .map(normalizedString)
        .join(" ");

      return haystack.includes(search);
    });

    const numericPrice = (item, missingValue) => {
      const price = Number(item.price);
      return Number.isFinite(price) ? price : missingValue;
    };

    const sorters = {
      quantity_desc: (a, b) => b.totalQuantity - a.totalQuantity,
      quantity_asc: (a, b) => a.totalQuantity - b.totalQuantity,
      price_desc: (a, b) =>
        numericPrice(b, Number.NEGATIVE_INFINITY) -
        numericPrice(a, Number.NEGATIVE_INFINITY),
      price_asc: (a, b) =>
        numericPrice(a, Number.POSITIVE_INFINITY) -
        numericPrice(b, Number.POSITIVE_INFINITY),
      name_asc: (a, b) => compareText(a.name, b.name),
      name_desc: (a, b) => compareText(b.name, a.name),
      set_asc: (a, b) =>
        compareText(
          `${a.setCode || ""} ${a.setName || ""}`,
          `${b.setCode || ""} ${b.setName || ""}`
        ),
      set_desc: (a, b) =>
        compareText(
          `${b.setCode || ""} ${b.setName || ""}`,
          `${a.setCode || ""} ${a.setName || ""}`
        ),
      rarity_asc: (a, b) => compareText(a.rarity, b.rarity),
      updated_desc: (a, b) =>
        new Date(b.updatedAt || 0).getTime() -
        new Date(a.updatedAt || 0).getTime(),
    };

    const sorter = sorters[sort] || sorters.quantity_desc;
    filteredItems.sort((a, b) => sorter(a, b) || compareText(a.name, b.name));

    const total = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * pageSize;
    const items = filteredItems.slice(start, start + pageSize);

    const summary = filteredItems.reduce(
      (acc, item) => {
        const quantity = Math.max(0, finiteNumber(item.totalQuantity));
        const price = Math.max(0, finiteNumber(item.price));

        acc.totalSkus += 1;
        acc.totalQuantity += quantity;
        acc.inventoryValue += quantity * price;
        return acc;
      },
      {
        totalSkus: 0,
        totalQuantity: 0,
        inventoryValue: 0,
      }
    );

    return res.json({
      items,
      total,
      page,
      pageSize,
      totalPages,
      filters: filterOptions,
      summary,
    });
  } catch (err) {
    console.error("Error fetching card list:", err);
    return res.status(500).json({
      error: "Failed to fetch card list",
      details: err?.message || String(err),
    });
  }
});

export default router;
