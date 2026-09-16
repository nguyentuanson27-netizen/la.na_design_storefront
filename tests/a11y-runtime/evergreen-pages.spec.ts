import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BUYER_AXE_TAGS } from "./axe-tags";
import { buildPublicBrandFacts } from "../../src/content/public-brand-facts.ts";
import {
  describePublicAddress,
  describePublicSupportHours,
  describePublicDeliveryEstimate,
  describePublicExchangeFee,
  describePublicRefundWindow,
  describePublicReturnWindow,
  describePublicSizeTolerance,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_DELIVERY_FACTS,
  PUBLIC_LEGAL_FACTS,
  PUBLIC_RETURNS_POLICY,
  PUBLIC_SIZE_GUIDE,
} from "../../src/content/public-brand-facts.ts";
import { FULFILLMENT } from "../../src/brand/index.ts";

const HOST = "127.0.0.1";
const PORT = 3229;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`U33a evergreen page server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/search`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U33a evergreen page server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) server.kill("SIGKILL");
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_URL: BASE_URL,
      LA_SHIPPING_FEE_VND: "25000",
      LA_FREE_SHIPPING_SUBTOTAL_VND: "750000",
      LA_FREE_SHIPPING_MIN_QUANTITY: "4",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
});

test("U33a the Contact page publishes the approved channels and claims no other support route", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/contact`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1, name: "Liên hệ" })).toBeVisible();

  // Asserted against the fact authority, never literals: the footer, the Organization markup and
  // this page all render the same constant, and a literal here would let one of them drift.
  await expect(main).toContainText(PUBLIC_CONTACT_FACTS.telephone);
  await expect(main).toContainText(PUBLIC_CONTACT_FACTS.email);
  await expect(main).toContainText(describePublicAddress());
  await expect(main).toContainText(describePublicSupportHours());
  await expect(
    main.locator(`a[href="tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}"]`),
  ).toBeVisible();
  await expect(main.locator(`a[href="mailto:${PUBLIC_CONTACT_FACTS.email}"]`)).toBeVisible();
  await expect(main.locator(`a[href="${PUBLIC_CONTACT_FACTS.fanpageUrl}"]`)).toBeVisible();

  // No support channel or promise the owner has not approved. A contact form or a stated response
  // time would be a policy this repository invented.
  await expect(main.locator("form")).toHaveCount(0);
  for (const invented of [/phản hồi trong \d/i, /24\/7/, /live chat/i, /hotline miễn phí/i]) {
    await expect(main).not.toContainText(invented);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U33a the About page publishes the approved minimum and invents no brand history", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/about`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1, name: "Về La.na Design" })).toBeVisible();
  await expect(main).toContainText(PUBLIC_BRAND_POSITIONING);
  await expect(main).toContainText(PUBLIC_LEGAL_FACTS.legalEntityName);
  await expect(main).toContainText(PUBLIC_LEGAL_FACTS.taxCode);
  await expect(main).toContainText(describePublicAddress());

  // B6 withholds the founding year, the founder and any brand story or values. This is the
  // assertion that fails if a later edit writes an origin story into the page.
  for (const withheld of [
    /thành lập (?:năm|vào)/i,
    /founder/i,
    /nhà sáng lập/i,
    /sứ mệnh/i,
    /giá trị cốt lõi/i,
    /câu chuyện thương hiệu/i,
    /\b(?:19|20)\d{2}\b/,
  ]) {
    await expect(main).not.toContainText(withheld);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U33a/U33b each evergreen page is reachable from the site footer", async ({ page }) => {
  // Started from an evergreen page rather than the homepage on purpose: the footer is site-wide, so
  // any page proves reachability, and the homepage additionally needs the catalog database. Coupling
  // a navigation assertion to catalog availability makes it fail for reasons it does not test.
  await page.goto(`${BASE_URL}/about`, { waitUntil: "networkidle" });

  for (const path of ["/contact", "/shipping", "/returns", "/about"]) {
    await page.locator("footer").locator(`a[href="${path}"]`).click();
    await page.waitForURL((url) => url.pathname === path);
  }
});

test("U33b the Returns page renders every approved clause and adds none", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/returns`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(
    page.getByRole("heading", { level: 1, name: /Đổi trả .* hoàn tiền/ }),
  ).toBeVisible();

  // Every clause the owner approved reaches the page — the whole list, not a sample.
  for (const condition of PUBLIC_RETURNS_POLICY.productConditions) {
    await expect(main).toContainText(condition);
  }
  for (const supportedCase of PUBLIC_RETURNS_POLICY.supportedCases) {
    await expect(main).toContainText(supportedCase);
  }
  // The windows with their semantics, the no-exclusion state, and the later logistics decisions all
  // come from reviewed authorities. A value changed there while the page kept old wording fails here.
  await expect(main).toContainText(describePublicReturnWindow());
  await expect(main).toContainText(describePublicExchangeFee());
  await expect(main).toContainText(PUBLIC_RETURNS_POLICY.customerInitiatedShippingNote);
  await expect(main).toContainText(PUBLIC_RETURNS_POLICY.shopFaultShippingNote);
  await expect(main).toContainText(PUBLIC_RETURNS_POLICY.nonReturnableCategoriesNote);
  await expect(main).toContainText(describePublicRefundWindow());
  await expect(main).toContainText(PUBLIC_RETURNS_POLICY.refundChannelNote);
  await expect(main).toContainText(FULFILLMENT.returnLogistics.returnMethods.inStore);
  await expect(main).toContainText(FULFILLMENT.returnLogistics.returnMethods.byMail);
  await expect(main).toContainText(FULFILLMENT.returnLogistics.returnMethods.byMailResponsibility);
  await expect(main).toContainText(FULFILLMENT.returnLogistics.restockingFeeNote);

  // No category exclusion or separate storage fee was approved. "Restocking" itself is no longer a
  // forbidden word because the owner explicitly approved the truthful zero-fee disclosure above.
  for (const invented of [/phí lưu kho/i, /không áp dụng cho/i, /danh mục loại trừ:/i]) {
    await expect(main).not.toContainText(invented);
  }

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U33b the Shipping page states estimates as estimates and only the supported payment method", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/shipping`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(main).toContainText(PUBLIC_DELIVERY_FACTS.coverage);
  for (const carrier of PUBLIC_DELIVERY_FACTS.carriers) {
    await expect(main).toContainText(carrier);
  }
  await expect(main).toContainText(FULFILLMENT.deliveryScopeLabels.innerCity);
  await expect(main).toContainText(FULFILLMENT.deliveryScopeLabels.otherProvince);
  await expect(main).toContainText(
    describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.innerCity),
  );
  await expect(main).toContainText(
    describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.otherProvince),
  );

  // §5: an estimate presented as a promise is a policy the owner did not make, and the absence of
  // carrier tracking is stated rather than left for a buyer to assume.
  await expect(main).toContainText(PUBLIC_DELIVERY_FACTS.estimateCaveat);
  await expect(main).toContainText(PUBLIC_DELIVERY_FACTS.carrierTrackingNote);
  for (const overclaim of [/cam kết giao trong/i, /đảm bảo giao/i, /theo dõi đơn hàng GHN/i]) {
    await expect(main).not.toContainText(overclaim);
  }

  // Exactly the method checkout supports, from the builder that already owned that fact — the same
  // one the footer renders, so the page and the footer cannot describe different payment terms.
  const brandFacts = buildPublicBrandFacts({
    feeVnd: 25_000,
    freeShippingSubtotalVnd: 750_000,
    freeShippingMinQuantity: 4,
  });
  await expect(main).toContainText(brandFacts.paymentMethod);
  await expect(main).toContainText(brandFacts.checkoutAccount);
  // The tracking capability sentence is the builder's, not a second telling on this page.
  await expect(main).toContainText(brandFacts.orderTracking.detail);
  for (const unsupported of [/thẻ tín dụng/i, /ví điện tử/i, /momo/i, /vnpay/i]) {
    await expect(main).not.toContainText(unsupported);
  }

  // The shipping price comes from the server-owned policy this spec's server was started with.
  await expect(main).toContainText("750.000");
  await expect(main).toContainText("4 sản phẩm");

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U33c the Size Guide page renders every approved chart with circumference and tolerance semantics", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/size-guide`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1, name: "Hướng dẫn chọn size" })).toBeVisible();

  // Unit cm, circumference semantics, tolerance and guidance visible
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.unit);
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote);
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.toleranceNote);
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.guidanceNote);
  await expect(main).toContainText(describePublicSizeTolerance());

  // Every approved chart: its heading, every row parameter and every cell, checked against that
  // chart's own size scale rather than one shared list.
  for (const chart of PUBLIC_SIZE_GUIDE.charts) {
    await expect(page.getByRole("heading", { level: 2, name: chart.title })).toBeVisible();
    for (const row of chart.rows) {
      await expect(main).toContainText(row.parameter);
      for (const size of chart.sizes) {
        await expect(main).toContainText(row.values[size]);
      }
    }
  }

  // Negative assertions: no fit guarantees, no invented claims
  for (const overclaim of [/đảm bảo vừa/i, /chắc chắn vừa/i, /fit guaranteed/i, /cam kết vừa/i]) {
    await expect(main).not.toContainText(overclaim);
  }

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});
