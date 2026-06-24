import axios from "axios";

const MANAPOOL_API_BASE_URL =
  process.env.MANAPOOL_API_BASE_URL || "https://manapool.com/api/v1";

const MANAPOOL_EMAIL = process.env.MANAPOOL_EMAIL;
const MANAPOOL_ACCESS_TOKEN = process.env.MANAPOOL_ACCESS_TOKEN;

if (!MANAPOOL_EMAIL || !MANAPOOL_ACCESS_TOKEN) {
  console.warn(
    "[ManaPool] Missing MANAPOOL_EMAIL or MANAPOOL_ACCESS_TOKEN in .env"
  );
}

const manapoolApi = axios.create({
  baseURL: MANAPOOL_API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-ManaPool-Email": MANAPOOL_EMAIL,
    "X-ManaPool-Access-Token": MANAPOOL_ACCESS_TOKEN,
  },
});

async function manapoolRequest(config) {
  try {
    const response = await manapoolApi.request(config);
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;

    console.error("[ManaPool API Error]", {
      method: config.method,
      url: config.url,
      status,
      data,
      message: error.message,
    });

    throw error;
  }
}

export async function testManaPoolConnection() {
  return manapoolRequest({
    method: "GET",
    url: "/seller/orders",
    params: {
      limit: 1,
    },
  });
}

export async function getSellerOrders(params = {}) {
  return manapoolRequest({
    method: "GET",
    url: "/seller/orders",
    params,
  });
}

export async function getSellerOrderById(orderId) {
  return manapoolRequest({
    method: "GET",
    url: `/seller/orders/${orderId}`,
  });
}

export async function searchSingleProducts(params = {}) {
  return manapoolRequest({
    method: "GET",
    url: "/products/singles",
    params,
  });
}

export async function updateInventoryByTcgSku(items = []) {
  return manapoolRequest({
    method: "POST",
    url: "/seller/inventory/tcgsku",
    data: {
      items,
    },
  });
}