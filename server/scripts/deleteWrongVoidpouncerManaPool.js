import "dotenv/config";
import axios from "axios";

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

// This is the wrong SKU that got created:
// Voidpouncer - FOIL DAMAGED
const WRONG_TCGPLAYER_SKU = 7962848;

const manaPoolApi = axios.create({
  baseURL: MANAPOOL_API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-ManaPool-Email": MANAPOOL_EMAIL,
    "X-ManaPool-Access-Token": MANAPOOL_ACCESS_TOKEN,
  },
});

async function main() {
  if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
    console.error("❌ MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN missing in .env");
    process.exit(1);
  }

  console.log("Deleting wrong Mana Pool inventory item...");
  console.log({
    wrong_tcgplayer_sku: WRONG_TCGPLAYER_SKU,
    expected_wrong_listing: "Voidpouncer / FO / DMG",
  });

  const response = await manaPoolApi.delete(
    `/seller/inventory/tcgsku/${WRONG_TCGPLAYER_SKU}`
  );

  console.log("✅ Mana Pool delete response:");
  console.log(JSON.stringify(response.data, null, 2));
}

main().catch((err) => {
  console.error("❌ Delete failed:");
  console.error({
    status: err.response?.status,
    data: err.response?.data,
    message: err.message,
  });
  process.exit(1);
});