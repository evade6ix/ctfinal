// server/scripts/debugCtColors.js
import "dotenv/config";
import { ct } from "../ctClient.js";

async function main() {
  const client = ct();

  console.log("📄 Fetching CardTrader inventory via /products/export …");
  const res = await client.get("/products/export", {
    timeout: 180000,
  });

  const products = Array.isArray(res.data) ? res.data : [];
  console.log(`✅ Got ${products.length} products from /products/export`);

  let shown = 0;

  for (const prod of products) {
    // Only MTG (usually game_id = 1 on CardTrader)
    if (String(prod.game_id) !== "1") continue;

    const props = prod.properties_hash || {};
    const keys = Object.keys(props);

    // Find any key mentioning "color" (case-insensitive)
    const colorKeys = keys.filter((k) =>
      k.toLowerCase().includes("color")
    );

    if (!colorKeys.length) continue;

    console.log("====================================");
    console.log("id:", prod.id, "name:", prod.name_en);
    console.log("game_id:", prod.game_id);
    console.log("color-related keys:", colorKeys);
    console.log("properties_hash:", JSON.stringify(props, null, 2));

    shown++;
    if (shown >= 5) break; // only show first 5 examples
  }

  if (shown === 0) {
    console.log("⚠️ No MTG products had any 'color' keys in properties_hash.");
  } else {
    console.log(`✅ Printed ${shown} sample MTG products with color info.`);
  }
}

main().catch((err) => {
  console.error("❌ debugCtColors failed:", err?.response?.data || err.message);
});
