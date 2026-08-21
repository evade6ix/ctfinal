import express from "express";
import axios from "axios";
import { randomUUID } from "crypto";
import {
  finishOperationRun,
  recordCompletedOperation,
  startOperationRun,
} from "../services/operationRuns.js";

const router = express.Router();

const CT_BASE = "https://api.cardtrader.com/api/v2";
const TOKEN = process.env.CARDTRADER_TOKEN;
const MAX_JOB_LOGS = 300;
const DEFAULT_MARKETPLACE_DELAY_MS = 110; // ~9.1 marketplace calls/sec, under CardTrader's documented 10/sec limit.
const jobs = new Map();

function ct() {
  return axios.create({
    baseURL: CT_BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 180000,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function centsToMoney(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

function centsToPriceFloat(cents) {
  return Number((Math.round(Number(cents || 0)) / 100).toFixed(2));
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
    product?.price_cents ??
    product?.price?.cents ??
    product?.list_price?.cents ??
    product?.seller_price?.cents ??
    null;
  return value == null ? null : Math.round(Number(value));
}

function listingPriceCents(listing) {
  const value = listing?.price?.cents ?? listing?.listed_price?.cents ?? listing?.public_price?.cents ?? null;
  return value == null ? null : Math.round(Number(value));
}

function createJob(mode, options) {
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    mode,
    options,
    status: "queued",
    stage: "Queued",
    progress: 0,
    scanned: 0,
    totalToScan: 0,
    totalLiveProducts: 0,
    activeProducts: 0,
    changed: 0,
    skippedCount: 0,
    currentItem: null,
    startedAt: now,
    updatedAt: now,
    elapsedSeconds: 0,
    estimatedRemainingSeconds: null,
    logs: [],
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

function pushLog(job, message) {
  if (!job) return;
  job.logs.push({ at: new Date().toISOString(), message });
  if (job.logs.length > MAX_JOB_LOGS) job.logs.splice(0, job.logs.length - MAX_JOB_LOGS);
  job.updatedAt = new Date().toISOString();
}

function updateJobProgress(job) {
  if (!job) return;
  const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
  job.elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  job.progress = job.totalToScan > 0 ? Math.min(100, Math.round((job.scanned / job.totalToScan) * 100)) : 0;

  if (job.scanned > 0 && job.totalToScan > job.scanned) {
    const secondsPerItem = job.elapsedSeconds / job.scanned;
    job.estimatedRemainingSeconds = Math.max(0, Math.round(secondsPerItem * (job.totalToScan - job.scanned)));
  } else {
    job.estimatedRemainingSeconds = null;
  }

  job.updatedAt = new Date().toISOString();
}

function jobSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    scanned: job.scanned,
    totalToScan: job.totalToScan,
    totalLiveProducts: job.totalLiveProducts,
    activeProducts: job.activeProducts,
    changed: job.changed,
    skippedCount: job.skippedCount,
    currentItem: job.currentItem,
    elapsedSeconds: job.elapsedSeconds,
    estimatedRemainingSeconds: job.estimatedRemainingSeconds,
    logs: job.logs,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

async function fetchOwnProducts(api, job) {
  pushLog(job, "Fetching your CardTrader inventory from /products/export…");

  try {
    const { data } = await api.get("/products/export");
    const rows = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];
    pushLog(job, `Loaded ${rows.length} CardTrader product(s) from export.`);
    return rows;
  } catch (err) {
    pushLog(job, `/products/export failed; falling back to paginated /products. ${err?.response?.data?.error || err?.message || ""}`.trim());
  }

  const all = [];
  const perPage = 50;
  const maxPages = 80;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await api.get("/products", {
      params: { page, per_page: perPage },
    });

    const rows = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];
    if (!rows.length) break;

    all.push(...rows);
    pushLog(job, `Loaded page ${page}: ${rows.length} product(s), ${all.length} total so far.`);
    if (rows.length < perPage) break;
  }

  return all;
}

async function findEligibleCompetitor(api, product, ownProductIds, { requestDelayMs, marketplaceCache, job }) {
  const blueprintId = Number(productBlueprintId(product));
  const condition = productCondition(product);
  const foil = productFoil(product);

  if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
    return { competitor: null, ownListing: null, reason: "missing_blueprint_id", fromCache: false };
  }

  const cacheKey = `${blueprintId}|en|${foil ? "foil" : "nonfoil"}`;
  let listings = marketplaceCache?.get(cacheKey);
  let fromCache = true;

  if (!listings) {
    fromCache = false;
    await sleep(requestDelayMs);

    const { data } = await api.get("/marketplace/products", {
      params: {
        blueprint_id: blueprintId,
        language: "en",
        foil,
      },
    });

    listings = Array.isArray(data?.[String(blueprintId)]) ? data[String(blueprintId)] : [];
    marketplaceCache?.set(cacheKey, listings);
  }

  const ownListing = listings.find((listing) => String(listing?.id || "") === String(product?.id || "")) || null;

  const eligible = listings
    .filter((listing) => {
      const listingId = String(listing?.id || "");
      return (
        listingPriceCents(listing) != null &&
        !ownProductIds.has(listingId) &&
        listing?.user?.can_sell_via_hub === true &&
        isProfessionalCompatible(listing) &&
        listingCondition(listing) === condition &&
        listing?.on_vacation !== true &&
        listing?.graded !== true
      );
    })
    .sort((a, b) => listingPriceCents(a) - listingPriceCents(b));

  if (!eligible.length) {
    return { competitor: null, ownListing, reason: "no_eligible_market_listing", listingCount: listings.length, fromCache };
  }

  return { competitor: eligible[0], ownListing, reason: null, listingCount: listings.length, fromCache };
}

async function buildRepricePlan(options = {}, job = null) {
  const api = ct();
  const minPriceCents = Math.max(1, Math.round(Number(options.minPriceCents ?? 1)));
  const beatByCents = Math.max(1, Math.round(Number(options.beatByCents ?? 1)));
  const requestDelayMs = Math.max(DEFAULT_MARKETPLACE_DELAY_MS, Math.round(Number(options.requestDelayMs ?? DEFAULT_MARKETPLACE_DELAY_MS)));
  const limit = Number(options.limit || 0);
  const marketplaceCache = new Map();
  let marketplaceApiCalls = 0;
  let marketplaceCacheHits = 0;

  if (job) {
    job.status = "running";
    job.stage = "Loading inventory";
    pushLog(job, `Fast mode enabled: ${requestDelayMs}ms delay per uncached marketplace call (~${(1000 / requestDelayMs).toFixed(1)} calls/sec), plus per-preview marketplace cache.`);
    updateJobProgress(job);
  }

  const products = await fetchOwnProducts(api, job);
  const ownProductIds = new Set(products.map((product) => String(product?.id)).filter(Boolean));
  const activeProducts = products.filter((product) => productQuantity(product) > 0 && productPriceCents(product) != null);
  const targetProducts = limit > 0 ? activeProducts.slice(0, limit) : activeProducts;

  if (job) {
    job.totalLiveProducts = products.length;
    job.activeProducts = activeProducts.length;
    job.totalToScan = targetProducts.length;
    job.stage = "Scanning marketplace listings";
    pushLog(job, `Scanning ${targetProducts.length} active product(s). ${limit > 0 ? `Scan limit: ${limit}.` : "No scan limit."}`);
    updateJobProgress(job);
  }

  const changes = [];
  const skipped = [];

  for (let index = 0; index < targetProducts.length; index += 1) {
    const product = targetProducts[index];
    const productId = product?.id;
    const blueprintId = Number(productBlueprintId(product));
    const currentBaseCents = productPriceCents(product);
    const condition = productCondition(product);
    const foil = productFoil(product);
    const name = productName(product);

    if (job) {
      job.scanned = index;
      job.currentItem = name;
      updateJobProgress(job);
    }

    try {
      const { competitor, ownListing, reason, listingCount, fromCache } = await findEligibleCompetitor(api, product, ownProductIds, {
        requestDelayMs,
        marketplaceCache,
        job,
      });

      if (fromCache) marketplaceCacheHits += 1;
      else marketplaceApiCalls += 1;

      if (!competitor || listingPriceCents(competitor) == null) {
        skipped.push({
          productId,
          blueprintId,
          name,
          setCode: productSetCode(product),
          condition,
          foil,
          currentPrice: centsToMoney(currentBaseCents),
          reason,
          listingCount: listingCount ?? 0,
        });
      } else if (!ownListing || listingPriceCents(ownListing) == null) {
        skipped.push({
          productId,
          blueprintId,
          name,
          setCode: productSetCode(product),
          condition,
          foil,
          currentPrice: centsToMoney(currentBaseCents),
          marketPrice: centsToMoney(listingPriceCents(competitor)),
          marketSeller: competitor?.user?.username || null,
          reason: "own_market_listing_missing_cannot_infer_fee",
        });
      } else {
        const competitorListedCents = listingPriceCents(competitor);
        const currentListedCents = listingPriceCents(ownListing);
        const inferredFeeCents = Math.max(0, currentListedCents - currentBaseCents);
        const targetListedCents = competitorListedCents - beatByCents;
        const targetBaseCents = targetListedCents - inferredFeeCents;

        if (targetBaseCents < minPriceCents) {
          skipped.push({
            productId,
            blueprintId,
            name,
            setCode: productSetCode(product),
            condition,
            foil,
            currentPrice: centsToMoney(currentBaseCents),
            currentListedPrice: centsToMoney(currentListedCents),
            cardTraderFee: centsToMoney(inferredFeeCents),
            marketPrice: centsToMoney(competitorListedCents),
            targetListedPrice: centsToMoney(targetListedCents),
            targetPrice: centsToMoney(targetBaseCents),
            reason: "target_below_min_base_price",
          });
        } else if (targetBaseCents === currentBaseCents) {
          skipped.push({
            productId,
            blueprintId,
            name,
            setCode: productSetCode(product),
            condition,
            foil,
            currentPrice: centsToMoney(currentBaseCents),
            currentListedPrice: centsToMoney(currentListedCents),
            cardTraderFee: centsToMoney(inferredFeeCents),
            marketPrice: centsToMoney(competitorListedCents),
            targetListedPrice: centsToMoney(targetListedCents),
            targetPrice: centsToMoney(targetBaseCents),
            reason: "already_at_target",
          });
        } else {
          changes.push({
            productId,
            blueprintId,
            name,
            setCode: productSetCode(product),
            condition,
            foil,
            quantity: productQuantity(product),
            currentPriceCents: currentBaseCents,
            currentPrice: centsToMoney(currentBaseCents),
            currentListedPriceCents: currentListedCents,
            currentListedPrice: centsToMoney(currentListedCents),
            cardTraderFeeCents: inferredFeeCents,
            cardTraderFee: centsToMoney(inferredFeeCents),
            marketProductId: competitor.id,
            marketSeller: competitor?.user?.username || null,
            marketPriceCents: competitorListedCents,
            marketPrice: centsToMoney(competitorListedCents),
            targetListedPriceCents: targetListedCents,
            targetListedPrice: centsToMoney(targetListedCents),
            targetPriceCents: targetBaseCents,
            targetPrice: centsToMoney(targetBaseCents),
          });
        }
      }
    } catch (err) {
      skipped.push({
        productId,
        blueprintId,
        name,
        setCode: productSetCode(product),
        condition,
        foil,
        currentPrice: centsToMoney(currentBaseCents),
        reason: "lookup_failed",
        error: err?.response?.data || err?.message || String(err),
      });
    }

    if (job) {
      job.scanned = index + 1;
      job.changed = changes.length;
      job.skippedCount = skipped.length;
      updateJobProgress(job);
      if (job.scanned <= 5 || job.scanned % 10 === 0 || job.scanned === job.totalToScan) {
        pushLog(job, `Scanned ${job.scanned}/${job.totalToScan}. Changes: ${changes.length}. Skipped: ${skipped.length}. API calls: ${marketplaceApiCalls}. Cache hits: ${marketplaceCacheHits}. Current: ${name}`);
      }
    }
  }

  const result = {
    ok: true,
    mode: "preview",
    filters: {
      language: "en",
      cardTraderZero: true,
      sellerType: "ct_zero_professional_compatible",
      excludesOwnListings: true,
      pricingMode: "lowest_listed_price_minus_one_cent_with_inferred_fee",
      requiresOwnMarketplaceListing: true,
      marketplaceDelayMs: requestDelayMs,
      marketplaceApiCalls,
      marketplaceCacheHits,
      marketplaceCacheSize: marketplaceCache.size,
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

  if (job) {
    job.stage = "Complete";
    job.status = "completed";
    job.progress = 100;
    job.changed = changes.length;
    job.skippedCount = skipped.length;
    job.currentItem = null;
    job.result = result;
    pushLog(job, `Preview complete. ${changes.length} change(s), ${skipped.length} skipped. Marketplace API calls: ${marketplaceApiCalls}. Cache hits: ${marketplaceCacheHits}.`);
    updateJobProgress(job);
  }

  return result;
}

function startPreviewJob(options) {
  const job = createJob("preview", options);
  pushLog(job, "Preview job queued.");

  setImmediate(async () => {
    const operation = await startOperationRun({
      kind: "repricer-preview",
      label: "CardTrader repricing preview",
      source: "cardtrader",
      trigger: "manual",
      initiatedBy: String(options?.initiatedBy || "local"),
      summary: { jobId: job.id },
    });

    try {
      await buildRepricePlan(options, job);
      await finishOperationRun(operation, {
        summary: {
          jobId: job.id,
          scanned: job.result?.scanned || 0,
          changed: job.result?.changed || 0,
          skipped: job.result?.skipped || 0,
        },
      });
    } catch (err) {
      job.status = "failed";
      job.stage = "Failed";
      job.error = err?.response?.data?.error || err?.message || String(err);
      pushLog(job, `Preview failed: ${job.error}`);
      updateJobProgress(job);
      console.error("CardTrader repricer preview job failed", err?.response?.data || err);
      await finishOperationRun(operation, {
        status: "failed",
        errors: [{ message: job.error }],
        summary: { jobId: job.id },
      });
    }
  });

  return job;
}

router.post("/preview/start", async (req, res) => {
  try {
    if (!TOKEN) return res.status(500).json({ error: "CARDTRADER_TOKEN missing" });
    const job = startPreviewJob(req.body || {});
    res.json(jobSnapshot(job));
  } catch (err) {
    console.error("CardTrader repricer preview start failed", err?.response?.data || err);
    res.status(500).json({ error: "repricer_preview_start_failed", details: err?.response?.data || err.message });
  }
});

router.get("/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  res.json(jobSnapshot(job));
});

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
  const startedAt = new Date();
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
          price: centsToPriceFloat(change.targetPriceCents),
        });

        updated += 1;
        results.push({ ...change, ok: true, response: data });
      } catch (err) {
        failed += 1;
        results.push({
          ...change,
          ok: false,
          error: err?.response?.data || err?.message || String(err),
        });
      }
    }

    const response = {
      ...plan,
      mode: "apply",
      attemptedUpdates: changesToApply.length,
      updated,
      failed,
      results,
    };

    await recordCompletedOperation({
      kind: "repricer-apply",
      label: "Applied CardTrader price updates",
      source: "cardtrader",
      trigger: "manual",
      initiatedBy: String(req.body?.initiatedBy || "local"),
      startedAt,
      status: failed ? "completed_with_errors" : "completed",
      summary: { attempted: changesToApply.length, updated, failed },
      errors: results.filter((result) => !result.ok).map((result) => ({
        productId: result.productId,
        name: result.name,
        message: result.error,
      })),
    });

    res.json(response);
  } catch (err) {
    console.error("CardTrader repricer apply failed", err?.response?.data || err);
    res.status(500).json({ error: "repricer_apply_failed", details: err?.response?.data || err.message });
  }
});

export default router;
