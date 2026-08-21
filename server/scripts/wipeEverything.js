import "dotenv/config";
import axios from "axios";

const CONFIRM = process.argv.includes("--confirm");
const DRY_RUN = !CONFIRM;

const CARDTRADER_TOKEN =
  process.env.CARDTRADER_API_TOKEN ||
  process.env.CT_API_TOKEN ||
  process.env.CARDTRADER_TOKEN;

if (!CARDTRADER_TOKEN) {
  console.error("❌ Missing CardTrader API token in .env");
  process.exit(1);
}

const ct = axios.create({
  baseURL: "https://api.cardtrader.com/api/v2",
  headers: {
    Authorization: `Bearer ${CARDTRADER_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 180000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bulk endpoints are async. Keep chunks reasonable.
const DESTROY_CHUNK_SIZE = 500;

// Job endpoint is 1 request/sec max.
const JOB_POLL_DELAY_MS = 1500;

async function fetchAllProducts() {
  console.log("Fetching full CardTrader inventory via /products/export...");

  const res = await ct.get("/products/export");

  if (!Array.isArray(res.data)) {
    throw new Error("Unexpected /products/export response. Expected an array.");
  }

  return res.data;
}

async function waitForJob(jobId) {
  while (true) {
    await sleep(JOB_POLL_DELAY_MS);

    const res = await ct.get(`/jobs/${jobId}`);
    const job = res.data;

    const state = job?.state;
    const stats = job?.stats || {};

    console.log(
      `Job ${jobId}: ${state} | ok=${stats.ok ?? 0}, warning=${stats.warning ?? 0}, error=${stats.error ?? 0}, pending=${stats.pending ?? 0}`
    );

    if (state === "completed" || state === "unprocessable") {
      return job;
    }
  }
}

async function bulkDestroy(products) {
  const productIds = products.map((p) => p.id).filter(Boolean);

  console.log(`Found ${productIds.length} CardTrader products.`);

  if (DRY_RUN) {
    console.log("⚠️ DRY RUN MODE — no products will be deleted.");
    console.log("First 25 IDs:");
    console.log(productIds.slice(0, 25).join(", "));
    console.log("\nRun live with:");
    console.log("node scripts/wipeEverything.js --confirm");
    return;
  }

  for (let i = 0; i < productIds.length; i += DESTROY_CHUNK_SIZE) {
    const ids = productIds.slice(i, i + DESTROY_CHUNK_SIZE);

    console.log(
      `\nSubmitting bulk_destroy ${i + 1}-${i + ids.length} of ${productIds.length}...`
    );

    const res = await ct.post("/products/bulk_destroy", {
      products: ids.map((id) => ({ id })),
    });

    const jobId = res.data?.job;

    if (!jobId) {
      console.error("❌ No job returned:", res.data);
      continue;
    }

    console.log(`Submitted job: ${jobId}`);

    const finishedJob = await waitForJob(jobId);

    const stats = finishedJob?.stats || {};
    console.log(
      `Finished job ${jobId}: state=${finishedJob.state}, ok=${stats.ok ?? 0}, warning=${stats.warning ?? 0}, error=${stats.error ?? 0}`
    );

    if ((stats.error || 0) > 0) {
      console.log("Errors:");
      console.dir(
        (finishedJob.results || []).filter((r) => r.result === "error").slice(0, 20),
        { depth: 5 }
      );
    }
  }
}

async function main() {
  console.log("\n==============================");
  console.log("CARDTRADER BULK DESTROY WIPE");
  console.log("==============================");

  const products = await fetchAllProducts();
  await bulkDestroy(products);

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("❌ Fatal:", err.response?.data || err.message || err);
  process.exit(1);
});