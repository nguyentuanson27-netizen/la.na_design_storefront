import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { OPTIMIZED_IMAGE_ROUTE } from "./image-routes";
const ROOT = resolve(import.meta.dirname, "../.."),
  BASE = "http://127.0.0.1:3475",
  SHOP = 925230;
const key = `list-price-browser-${Date.now()}`,
  name = "Bộ giá niêm yết thử nghiệm";
const photo = "https://content.pancake.vn/1/2026/10/30/list-price-photo.jpg";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
let server: ChildProcess | undefined,
  output = "",
  productId = "";
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), delay(5000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
  server = undefined;
}
async function start(basis: boolean, display = true) {
  await stop();
  output = "";
  server = spawn(
    process.execPath,
    [
      resolve(ROOT, "node_modules/next/dist/bin/next"),
      NEXT_SERVER_COMMAND,
      "--hostname",
      "127.0.0.1",
      "--port",
      "3475",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...nextServerEnv(".next-test/list-price"),
        PANCAKE_SHOP_ID: String(SHOP),
        APP_DOMAIN: "127.0.0.1:3475",
        BETTER_AUTH_URL: BASE,
        LIST_PRICE_DISPLAY: String(display),
        LIST_PRICE_CAMPAIGN_BASIS: String(basis),
        LA_GIFT_QUANTITY_ENABLED: "false",
        LA_VOUCHER_ENABLED: "false",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (b) => {
    output = (output + b.toString()).slice(-10000);
  });
  server.stderr?.on("data", (b) => {
    output = (output + b.toString()).slice(-10000);
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error(`Test server exited: ${output}`);
    try {
      const r = await fetch(`${BASE}/shop/${key}`);
      if (r.ok && (await r.text()).includes(name)) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`Test server did not start: ${output}`);
}
async function cleanup() {
  await prisma.cart.deleteMany({
    where: {
      items: { some: { variant: { product: { pancakeProductId: key } } } },
    },
  });
  await prisma.promotionCampaign.deleteMany({ where: { name: key } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: key } });
}
test.beforeAll(async () => {
  await cleanup();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP,
      pancakeProductId: key,
      slug: key,
      name,
      syncedAt: new Date(),
      primaryImageUrl: photo,
      variants: {
        create: [429000, 590000].map((price, i) => ({
          pancakeVariationId: key + i,
          pancakeDisplayId: `MPN-LIST-PRICE-${i}`,
          size: i ? "M" : "S",
          pancakeRetailPrice: price,
          pancakeRetailPriceAfterDiscount: price,
          syncedAt: new Date(),
          pancakeImageUrls: [photo],
          warehouseStocks: {
            create: {
              pancakeWarehouseId: "list-price-wh",
              quantity: 5,
              syncedAt: new Date(),
            },
          },
        })),
      },
    },
  });
  productId = product.id;
  await start(false);
});
test.beforeEach(async ({ page }) => {
  await page.route(OPTIMIZED_IMAGE_ROUTE, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  await page.route("https://content.pancake.vn/**/*.jpg", (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
});
test.afterAll(async () => {
  await stop();
  await cleanup();
  await prisma.$disconnect();
});
for (const width of [390, 1440])
  test(`display-only coherent card/PDP triples, safe layout and no campaign at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/shop`);
    const card = page
      .locator("article")
      .filter({
        has: page.getByRole("link", { name: `Xem ${name}`, exact: true }),
      });
    await expect(card).toHaveCount(1);
    await expect(card.locator("del")).toHaveText(/549.000/);
    await expect(card.locator(".product-price")).toContainText(/429.000/);
    await expect(card).toContainText("-22%");
    await page.goto(`${BASE}/shop/${key}`);
    const panel = page.getByRole("region", { name: "Mua sản phẩm" });
    await expect(panel).toContainText(/549.000/);
    await panel
      .getByRole("group", { name: "Kích cỡ" })
      .getByText("M", { exact: true })
      .click();
    await expect(panel).toContainText(/590.000/);
    await expect(panel).toContainText(/749.000/);
    await expect(panel).toContainText("-21%");
    await expect(page.locator(".pdp-flash-tag")).toHaveCount(0);
    expect(await prisma.promotionCampaign.count({ where: { name: key } })).toBe(
      0,
    );
    const axe = await new AxeBuilder({ page })
      .include('[aria-label="Mua sản phẩm"]')
      .withTags(BUYER_AXE_TAGS)
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
test("long list and payable prices fit the phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prisma.variantMirror.update({
    where: { pancakeVariationId: key + 1 },
    data: { pancakeRetailPrice: 1000000000000 },
  });
  try {
    await page.goto(`${BASE}/shop/${key}`);
    await page
      .getByRole("region", { name: "Mua sản phẩm" })
      .getByRole("group", { name: "Kích cỡ" })
      .getByText("M", { exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await prisma.variantMirror.update({
      where: { pancakeVariationId: key + 1 },
      data: { pancakeRetailPrice: 590000 },
    });
  }
});
test("cart, drawer and checkout show list reference/savings while charging unchanged POS money", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/shop/${key}`);
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  await panel
    .getByRole("group", { name: "Kích cỡ" })
    .getByText("M", { exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Đã thêm");
  await page
    .getByRole("button", { name: /^Giỏ hàng/ })
    .filter({ visible: true })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "Giỏ hàng" });
  await expect(drawer.locator("[data-line-discount]").first()).toContainText(
    /749.000/,
  );
  await expect(drawer.locator("[data-list-price-savings]")).toContainText(
    /159.000/,
  );
  await drawer.getByRole("button", { name: "Đóng giỏ hàng" }).click();
  await page.goto(`${BASE}/cart`);
  await expect(page.locator("[data-line-discount]").first()).toContainText(
    /749.000/,
  );
  await expect(page.locator("[data-line-discount]").first()).toContainText(
    /590.000/,
  );
  await expect(page.locator("[data-cart-savings]")).toContainText(/159.000/);
  await expect(page.locator("[data-cart-savings] dt")).toHaveText([
    "Tổng theo giá niêm yết", "Tiết kiệm so với giá niêm yết",
  ]);
  await page.goto(`${BASE}/checkout`);
  await expect(page.locator("[data-line-discount]").first()).toContainText(
    /749.000/,
  );
  await expect(page.locator("[data-line-discount]").first()).toContainText(
    /590.000/,
  );
  await expect(page.locator("[data-list-price-savings]").first()).toContainText(
    /159.000/,
  );
});

test("cart savings labels switch ON/OFF while payable campaign money stays unchanged on mobile", async ({ page }) => {
  await prisma.promotionCampaign.create({ data: {
    name: key, kind: "PROMOTION", discountType: "PERCENTAGE", percentageValue: 10,
    isEnabled: true, enabledAt: new Date(), targets: { create: { productId } },
  } });
  try {
    for (const display of [false, true]) {
      await start(false, display);
      await page.setViewportSize({ width: 390, height: 844 });
      // A fresh cart for each flag prevents quantity from accumulating across additions.
      await page.context().clearCookies();
      await page.goto(`${BASE}/shop/${key}`);
      const panel = page.getByRole("region", { name: "Mua sản phẩm" });
      await panel.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();
      await panel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText("Đã thêm");
      await page.goto(`${BASE}/cart`);
      const savings = page.locator("[data-cart-savings]");
      await expect(savings.locator("dt")).toHaveText(display
        ? ["Tổng theo giá niêm yết", "Tiết kiệm so với giá niêm yết"]
        : ["Tổng", "Tiết kiệm"]);
      await expect(savings.locator("dd").first()).toContainText(display ? /749.000/ : /590.000/);
      await expect(savings.locator("dd").last()).toContainText(display ? /218.000/ : /59.000/);
      await expect(page.locator("[data-line-discount]").first()).toContainText(/531.000/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    await prisma.promotionCampaign.deleteMany({ where: { name: key } });
    await start(false);
  }
});
test("basis ON shows the rounded campaign amount, while JSON-LD still publishes only actual payable price", async ({
  page,
}) => {
  await prisma.promotionCampaign.create({
    data: {
      name: key,
      kind: "PROMOTION",
      discountType: "PERCENTAGE",
      percentageValue: 25,
      isEnabled: true,
      enabledAt: new Date(),
      targets: { create: { productId } },
    },
  });
  await start(true);
  await page.goto(`${BASE}/shop/${key}`);
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  await panel
    .getByRole("group", { name: "Kích cỡ" })
    .getByText("M", { exact: true })
    .click();
  await expect(panel).toContainText(/562.000/);
  await expect(panel).toContainText(/749.000/);
  await expect(panel).toContainText("-25%");
  const documents = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  expect(documents.join("\n")).not.toContain("StrikethroughPrice");
  expect(documents.join("\n")).not.toContain('"price":749000');
  expect(documents.join("\n")).toContain('"price":412000');
});
