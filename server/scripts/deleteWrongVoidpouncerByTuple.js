import "dotenv/config";
import axios from "axios";

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";
const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

// Wrong listing that got created:
// Voidpouncer / English / Foil / Damaged
const SCRYFALL_ID = "1f9b8532-4f1a-4653-9cbb-befba8169e5a";
const LANGUAGE_ID = "EN";
const FINISH_ID = "FO";
const CONDITION_ID = "DMG";

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

  console.log("Deleting wrong Mana Pool inventory tuple...");
  console.log({
    scryfall_id: SCRYFALL_ID,
    language_id: LANGUAGE_ID,
    finish_id: FINISH_ID,
    condition_id: CONDITION_ID,
  });

  const response = await manaPoolApi.delete(
    `/seller/inventory/scryfall_id/${SCRYFALL_ID}`,
    {
      params: {
        language_id: LANGUAGE_ID,
        finish_id: FINISH_ID,
        condition_id: CONDITION_ID,
      },
    }
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