const originalFetch = globalThis.fetch;

const PANCAKE_ORIGIN = "https://pos.pages.fm";
const API_PREFIX = "/api/v1";
const TEST_API_KEY = "checkout-a11y-test-key";
const SHOP_ID = "920007";
const PROVINCE_LEGACY = "province-legacy";
const PROVINCE_CURRENT = "province-current";
const DISTRICT_LEGACY = "district-legacy";
const DISTRICT_SLOW = "district-slow";
const DISTRICT_CURRENT = "district-current";
const COMMUNE_LEGACY = "commune-legacy";
const COMMUNE_STALE = "commune-stale";
const COMMUNE_CURRENT = "commune-current";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function queryMatches(url, expected) {
  const actual = new URLSearchParams(url.searchParams);
  actual.delete("api_key");
  return (
    url.searchParams.get("api_key") === TEST_API_KEY &&
    actual.toString() === new URLSearchParams(expected).toString()
  );
}

const configuredOrderIdSeed = Number(process.env.PANCAKE_A11Y_ORDER_ID_SEED ?? "987654321");
if (!Number.isSafeInteger(configuredOrderIdSeed) || configuredOrderIdSeed <= 0) {
  throw new Error("PANCAKE_A11Y_ORDER_ID_SEED must be a positive safe integer");
}
let nextOrderId = configuredOrderIdSeed;

async function pancakeResponse(url, init) {
  if (url.pathname === `${API_PREFIX}/geo/provinces`) {
    if (!queryMatches(url, { country_code: "84", all: "true" })) {
      return json({ error: "unexpected province query" }, 400);
    }
    return json({
      data: [
        { id: PROVINCE_LEGACY, name: "Tỉnh Legacy" },
        { id: PROVINCE_CURRENT, name: "Tỉnh Current" },
      ],
    });
  }

  if (url.pathname === `${API_PREFIX}/geo/districts`) {
    const provinceId = url.searchParams.get("province_id");
    if (!queryMatches(url, { province_id: provinceId ?? "" })) {
      return json({ error: "unexpected district query" }, 400);
    }
    if (provinceId === PROVINCE_LEGACY) {
      return json({
        data: [
          { id: DISTRICT_LEGACY, name: "Huyện Legacy", province_id: PROVINCE_LEGACY },
        ],
      });
    }
    if (provinceId === PROVINCE_CURRENT) {
      return json({
        data: [
          { id: DISTRICT_SLOW, name: "Quận Chậm", province_id: PROVINCE_CURRENT },
          { id: DISTRICT_CURRENT, name: "Quận Current", province_id: PROVINCE_CURRENT },
        ],
      });
    }
    return json({ error: "unknown province" }, 400);
  }

  if (url.pathname === `${API_PREFIX}/geo/communes`) {
    const provinceId = url.searchParams.get("province_id");
    const districtId = url.searchParams.get("district_id");
    if (!queryMatches(url, { district_id: districtId ?? "", province_id: provinceId ?? "" })) {
      return json({ error: "unexpected commune query" }, 400);
    }
    if (provinceId === PROVINCE_LEGACY && districtId === DISTRICT_LEGACY) {
      return json({
        data: [
          {
            id: COMMUNE_LEGACY,
            name: "Xã Legacy",
            province_id: PROVINCE_LEGACY,
            district_id: DISTRICT_LEGACY,
          },
        ],
      });
    }
    if (provinceId === PROVINCE_CURRENT && districtId === DISTRICT_SLOW) {
      await sleep(300);
      return json({
        data: [
          {
            id: COMMUNE_STALE,
            name: "Phường Stale",
            province_id: PROVINCE_CURRENT,
            district_id: DISTRICT_SLOW,
          },
        ],
      });
    }
    if (provinceId === PROVINCE_CURRENT && districtId === DISTRICT_CURRENT) {
      await sleep(20);
      return json({
        data: [
          {
            id: COMMUNE_CURRENT,
            name: "Phường Current",
            province_id: PROVINCE_CURRENT,
            district_id: DISTRICT_CURRENT,
          },
        ],
      });
    }
    return json({ error: "unknown district" }, 400);
  }

  if (url.pathname === `${API_PREFIX}/shops/${SHOP_ID}/products/variations`) {
    if (!queryMatches(url, { page_number: "1", page_size: "100" })) {
      return json({ error: "unexpected catalog query" }, 400);
    }
    const productId = process.env.PANCAKE_A11Y_PRODUCT_ID;
    const variationId = process.env.PANCAKE_A11Y_VARIATION_ID;
    const warehouseId = process.env.PANCAKE_A11Y_WAREHOUSE_ID;
    if (!productId || !variationId || !warehouseId) {
      return json({ error: "missing checkout fixture identity" }, 500);
    }
    return json({
      success: true,
      page_number: 1,
      page_size: 100,
      total_entries: 1,
      total_pages: 1,
      data: [
        {
          id: variationId,
          product_id: productId,
          display_id: "CHECKOUT-A11Y",
          barcode: "",
          fields: [],
          images: [],
          is_hidden: false,
          is_locked: false,
          retail_price: 500000,
          retail_price_after_discount: 500000,
          product: { id: productId, name: "Checkout A11y Product" },
          variations_warehouses: [
            { warehouse_id: warehouseId, remain_quantity: 5 },
          ],
        },
      ],
    });
  }

  if (url.pathname === `${API_PREFIX}/shops/${SHOP_ID}/orders`) {
    if (url.searchParams.get("api_key") !== TEST_API_KEY || url.searchParams.size !== 1) {
      return json({ error: "unexpected create-order query" }, 400);
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return json({ error: "unexpected create-order request" }, 400);
    }
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      return json({ error: "malformed create-order body" }, 400);
    }
    const variationId = process.env.PANCAKE_A11Y_VARIATION_ID;
    if (
      body?.shop_id !== Number(SHOP_ID) ||
      body?.shipping_address?.province_id !== PROVINCE_CURRENT ||
      body?.shipping_address?.district_id !== DISTRICT_CURRENT ||
      body?.shipping_address?.commune_id !== COMMUNE_CURRENT ||
      body?.items?.length !== 1 ||
      body.items[0]?.variation_id !== variationId ||
      body.items[0]?.quantity !== 1 ||
      body.items[0]?.variation_info?.retail_price !== 500000
    ) {
      return json({ error: "unexpected create-order body" }, 400);
    }
    return json({ id: nextOrderId++ });
  }

  return json({ error: "unhandled Pancake fixture request" }, 500);
}

globalThis.fetch = async function checkoutA11yFetch(input, init) {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === "string" ? input : input.url);
  if (url.origin === PANCAKE_ORIGIN && url.pathname.startsWith(`${API_PREFIX}/`)) {
    return pancakeResponse(url, init);
  }
  return originalFetch(input, init);
};
