import express from "express";
import axios from "axios";
import { InventoryItem } from "../models/InventoryItem.js";

const router = express.Router();

const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 30000,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function centsToMoney(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

function normalizeCondition(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "m" || raw === "mint") return "Mint";
  if (raw === "nm" || raw === "near mint") return "Near Mint";
  if (raw === "lp" || raw === "lightly played" || raw === "slightly played") return "Slightly Played";
  if (raw === "mp" || raw === "moderately played") return "Moderately Played";
  if (raw === "p" || raw === "played") return "Played";
  if (raw === "hp" || raw === "heavily played") return "Heavily Played";
  if (raw === "poor") return "Poor";
  return "Near Mint";
}

function listingCondition(listing) {
  return normalizeCondition(
    listing?.properties_hash?.condition ||
      listing?.properties?.condition ||
      listing?.condition ||
      listing?.card_condition ||
      listing?.grading ||
      ""
  );
}

function normalizeUserType(value) {
  return String(value || "").trim().toLowerCase();
}

function isProfessionalCompatible(listing) {
  const userType = normalizeUserType(listing?.user?.user_type);
  if (!userType) return true;
  return userType === "professional" || userType === "pro" || userType.includes("professional");
}

function productBlueprintId(product) {
  return (
    product?.blueprint_id ||
    product?.product_blueprint_id ||
    product?.product_id ||
    product?.blueprint?.id ||
    product?.product_blueprint?.id ||
    product?.product?.id ||
    null
  );
}

function productName(product) {
  return (
    product?.blueprint?.name ||
    product?.product_blueprint?.name ||
    product?.product?.name ||
    product?.name ||
    product?.name_en ||
    "Unknown"
  );
}

function productSetCode(product) {
  const blueprint = product?.blueprint || product?.product_blueprint || product?.product || {};
  const expansion = blueprint?.expansion || product?.expansion || {};
  return expansion?.code || expansion?.shortCode || expansion?.short_code || product?.setCode || "";
}

function productCondition(product) {
  return normalizeCondition(
    product?.properties_hash?.condition ||
      product?.properties?.condition ||
      product?.condition ||
      product?.state ||
      product?.grading ||
      "Near Mint"
  );
}

function productFoil(product) {
  const props = product?.properties_hash || product?.properties || {};
  if (typeof props.mtg_foil === "boolean") return props.mtg_foil;
  if (typeof props.foil === "boolean") return props.foil;
  if (typeof product?.foil === "boolean") return product.foil;
  if (typeof product?.is_foil === "boolean") return product.is_foil;
  if (typeof product?.finish === "string") return product.finish.toLowerCase().includes("foil");
  return false;
}

function productQuantity(product) {
  return Number(product?.quantity ?? product?.stock ?? product?.available ?? 0);
}

function productPriceCents(product) {
  const value =
    product?.price?.cents ??
    product?.price_cents ??
    product?.list_price?.cents ??
    null;
  return value == null ? null : Math.round(Number(value));
}

async function fetchOwnProducts(api, { maxPages = 80, perPage = 100 } = {}) {
  const all = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await api.get("/products", {
      params: { page, per_page: perPage },
    });

    const rows = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];
    if (!rows.length) break;

    all.push(...rows);
    if (rows.length < perPage) break;
  }

  return all;
}

async function findEligibleCompetitor(api, product, ownProductIds, { requestDelayMs }) {
  const blueprintId = Number(productBlueprintId(product));
  const condition = productCondition(product);
  const foil = productFoil(product);

  if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
    return { competitor: null, reason: "missing_blueprint_id" };
  }

  await sleep(requestDelayMs);

  const { data } = await api.get("/marketplace/products", {
    params: {
      blueprint_id: blueprintId,
      language: "en",
      foil,
    },
  });

  const listings = Array.isArray(data?.[String(blueprintId)]) ? data[String(blueprintId)] : [];

  const eligible = listings
    .filter((listing) => {
      const listingId = String(listing?.id || "");
      return (
        listing?.price?.cents != null &&
        !ownProductIds.has(listingId) &&
        listing?.user?.can_sell_via_hub === true &&
        isProfessionalCompatible(listing) &&
        listingCondition(listing) === condition &&
        listing?.on_vacation !== true &&
        listing?.graded !== true
      );
    })
    .sort((a, b) => Number(a.price.cents) - Number(b.price.cents));

  if (!eligible.length) {
    return { competitor: null, reason: "no_eligible_market_listing", listingCount: listings.length };
  }

  return { competitor: eligible[0], reason: null, listingCount: listings.length };
}

async function buildRepricePlan(options = {}) {
  const api = ct();
  const minPriceCents = Math.max(1, Math.round(Number(options.minPriceCents ?? 1)));
  const beatByCents = Math.max(1, Math.round(Number(options.beatByCents ?? 1)));
  const requestDelayMs = Math.max(150, Math.round(Number(options.requestDelayMs ?? 175)));
  const limit = Number(options.limit || 0);

  const products = await fetchOwnProducts(api);
  const ownProductIds = new Set(products.map((product) => String(product?.id)).filter(Boolean));
  const activeProducts = products.filter((product) => productQuantity(product) > 0 && productPriceCents(product) != null);
  const targetProducts = limit > 0 ? activeProducts.slice(0, limit) : activeProducts;

  const changes = [];
  const skipped = [];

  for (let index = 0; index < targetProducts.length; index += 1) {
    const product = targetProducts[index];
    const productId = product?.id;
    const blueprintId = Number(productBlueprintId(product));
    const currentPriceCents = productPriceCents(product);
    const condition = productCondition(product);
    const foil = productFoil(product);

    try {
      const { competitor, reason, listingCount } = await findEligibleCompetitor(api, product, ownProductIds, {
        requestDelayMs,
      });

      if (!competitor?.price?.cents) {
        skipped.push({
          productId,
          blueprintId,
          name: productName(product),
          setCode: productSetCode(product),
          condition,
          foil,
          currentPrice: centsToMoney(currentPriceCents),
          reason,
          listingCount: listingCount ?? 0,
        });
        continue;
      }

      const competitorCents = Math.round(Number(competitor.price.cents));
      const targetCents = Math.max(minPriceCents, competitorCents - beatByCents);

      if (targetCents === currentPriceCents) {
        skipped.push({
          productId,
          blueprintId,
          name: productName(product),
          setCode: productSetCode(product),
          condition,
          foil,
          currentPrice: centsToMoney(currentPriceCents),
          marketPrice: centsToMoney(competitorCents),
          targetPrice: centsToMoney(targetCents),
          reason: "already_at_target",
        });
        continue;
      }

      changes.push({
        productId,
        blueprintId,
        name: productName(product),
        setCode: productSetCode(product),
        condition,
        foil,
        quantity: productQuantity(product),
        currentPriceCents,
        currentPrice: centsToMoney(currentPriceCents),
        marketProductId: competitor.id,
        marketSeller: competitor?.user?.username || null,
        marketPriceCents: competitorCents,
        marketPrice: centsToMoney(competitorCents),
        targetPriceCents: targetCents,
        targetPrice: centsToMoney(targetCents),
      });
    } catch (err) {
      skipped.push({
        productId,
        blueprintId,
        name: productName(product),
        setCode: productSetCode(product),
        condition,
        foil,
        currentPrice: centsToMoney(currentPriceCents),
        reason: "lookup_failed",
        error: err?.response?.data || err?.message || String(err),
      });
    }
  }

  return {
    ok: true,
    mode: "preview",
    filters: {
      language: "en",
      cardTraderZero: true,
      sellerType: "ct_zero_professional_compatible",
      excludesOwnListings: true,
      beatByCents,
      minPriceCents,
    },
    scanned: targetProducts.length,
    totalLiveProducts: products.length,
    activeProducts: activeProducts.length,
    changed: changes.length,
    skipped: skipped.length,
    changes,
    skipped,
  };
}

router.post("/preview", async (req, res) => {
  try {
    if (!TOKEN) return res.status(500).json({ error: "CARDTRADER_TOKEN missing" });
    const plan = await buildRepricePlan(req.body || {});
    res.json(plan);
  } catch (err) {
    console.error("CardTrader repricer preview failed", err?.response?.data || err);
    res.status(500).json({ error: "repricer_preview_failed", details: err?.response?.data || err.message });
  }
});

router.post("/apply", async (req, res) => {
  try {
    if (!TOKEN) return res.status(500).json({ error: "CARDTRADER_TOKEN missing" });

    const api = ct();
    const plan = await buildRepricePlan(req.body || {});
    const applyLimit = Number(req.body?.applyLimit || 0);
    const changesToApply = applyLimit > 0 ? plan.changes.slice(0, applyLimit) : plan.changes;
    const results = [];
    let updated = 0;
    let failed = 0;

    for (const change of changesToApply) {
      try {
        await sleep(125);
        const { data } = await api.put(`/products/${change.productId}`, {
          price_cents: change.targetPriceCents,
        });

        updated += 1;
        results.push({ ...change, ok: true, response: data });

        await InventoryItem.updateOne(
          { cardTraderId: Number(change.productId) },
          { $set: { price: change.targetPrice, updatedAt: new Date() } }
        ).catch(() => null);
      } catch (err) {
        failed += 1;
        results.push({
          ...change,
          ok: false,
          error: err?.response?.data || err?.message || String(err),
        });
      }
    }

    res.json({
      ...plan,
      mode: "apply",
      attemptedUpdates: changesToApply.length,
      updated,
      failed,
      results,
    });
  } catch (err) {
    console.error("CardTrader repricer apply failed", err?.response?.data || err);
    res.status(500).json({ error: "repricer_apply_failed", details: err?.response?.data || err.message });
  }
});

export default router;
