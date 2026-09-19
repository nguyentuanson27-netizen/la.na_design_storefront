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
import { buildPolicyHubViewModel } from "../../src/routes/evergreen-model.ts";

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

test("U33a the Contact page publishes approved channels and the approved F9b contact form", async ({
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

  const form = main.locator("form");
  await expect(form).toHaveCount(1);
  await expect(form.locator("input, textarea")).toHaveCount(3);
  await expect(form.getByLabel("Họ tên")).toHaveAttribute("name", "name");
  await expect(form.getByLabel("Email")).toHaveAttribute("name", "email");
  await expect(form.getByLabel("Email")).toHaveAttribute("maxlength", "254");
  await expect(form.getByLabel("Nội dung")).toHaveAttribute("name", "message");
  await expect(form.getByRole("button", { name: "Gửi tin nhắn" })).toBeVisible();

  const controlContrast = await form.getByLabel("Họ tên").evaluate((control) => {
    function rgba(value: string): [number, number, number, number] {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [red!, green!, blue!, alpha! / 255];
    }

    function luminance([red, green, blue]: [number, number, number]): number {
      const channels = [red, green, blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    }

    const border = rgba(getComputedStyle(control).borderTopColor);
    const background = rgba(getComputedStyle(document.body).backgroundColor);
    const effectiveBorder: [number, number, number] = [
      border[0] * border[3] + background[0] * (1 - border[3]),
      border[1] * border[3] + background[1] * (1 - border[3]),
      border[2] * border[3] + background[2] * (1 - border[3]),
    ];
    const lighter = luminance(background.slice(0, 3) as [number, number, number]);
    const darker = luminance(effectiveBorder);
    return (lighter + 0.05) / (darker + 0.05);
  });
  expect(controlContrast).toBeGreaterThanOrEqual(3);

  // F9b adds only the approved contact form; other unapproved support channels remain absent.
  for (const invented of [/24\/7/, /live chat/i, /hotline miễn phí/i]) {
    await expect(main).not.toContainText(invented);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("F9b server-only validation associates and focuses the first invalid contact field", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/contact`, { waitUntil: "networkidle" });

  const name = page.getByLabel("Họ tên");
  const email = page.getByLabel("Email");
  const message = page.getByLabel("Nội dung");
  const submit = page.getByRole("button", { name: "Gửi tin nhắn" });

  await name.fill("😀".repeat(101));
  await email.fill("an@example.com");
  await message.fill("Xin chào");
  await submit.click();

  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", "contact-name-error");
  await expect(page.locator("#contact-name-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#contact-name-error")).toContainText("1 đến 100");

  await name.fill("Nguyễn An");
  await message.fill("a".repeat(4_001));
  await submit.click();

  await expect(message).toBeFocused();
  await expect(message).toHaveAttribute("aria-invalid", "true");
  await expect(message).toHaveAttribute("aria-describedby", "contact-message-error");
  await expect(page.locator("#contact-message-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#contact-message-error")).toContainText("1 đến 4.000");
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

  // A7a: the registered legal identity, each fact under its own heading. The two addresses are the
  // pair that matters -- a customer reading the registered office as the return address posts a
  // parcel somewhere that does not receive one.
  await expect(main).toContainText(PUBLIC_LEGAL_FACTS.taxIdIssueDate);
  await expect(main).toContainText(PUBLIC_LEGAL_FACTS.registeredAddress);
  await expect(main).toContainText(PUBLIC_LEGAL_FACTS.legalEmail);
  await expect(main).toContainText(describePublicAddress());
  await expect(main).toContainText("Địa chỉ đăng ký kinh doanh");
  await expect(main).toContainText("Địa chỉ kinh doanh & nhận hàng đổi trả");

  // The owner withheld the legal representative from public display.
  for (const withheld of [/người đại diện/i, /đại diện pháp luật/i]) {
    await expect(main).not.toContainText(withheld);
  }

  // B6 withholds the founding year, the founder and any brand story or values. This is the
  // assertion that fails if a later edit writes an origin story into the page.
  for (const withheld of [
    /thành lập (?:năm|vào)/i,
    /founder/i,
    /nhà sáng lập/i,
    /sứ mệnh/i,
    /giá trị cốt lõi/i,
    /câu chuyện thương hiệu/i,
  ]) {
    await expect(main).not.toContainText(withheld);
  }

  // A year on this page may only be the approved tax issue date. Anything else is a founding year,
  // which is the fact B6 withheld -- so the check is "no other year", not "no year at all".
  const years = ((await main.innerText()).match(/\b(?:19|20)\d{2}\b/g) ?? []);
  for (const year of years) {
    expect(PUBLIC_LEGAL_FACTS.taxIdIssueDate).toContain(year);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U33a/U33b required support pages are reachable from the final site footer", async ({ page }) => {
  // Started from an evergreen page rather than the homepage on purpose: the footer is site-wide, so
  // any page proves reachability, and the homepage additionally needs the catalog database. F9a §33
  // requires the support/policy destinations below; About remains public but is not a footer item.
  await page.goto(`${BASE_URL}/about`, { waitUntil: "networkidle" });

  const destinations = [
    { path: "/contact", label: "Thông tin liên hệ" },
    { path: "/shipping", label: "Chính sách vận chuyển" },
    { path: "/returns", label: "Chính sách đổi trả và hoàn tiền" },
  ] as const;

  for (const destination of destinations) {
    await page
      .locator("footer")
      .getByRole("link", { name: destination.label, exact: true })
      .click();
    await page.waitForURL((url) => url.pathname === destination.path);
  }
});

test("A7b every policy topic resolves to a live destination at a stable anchor", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/policies`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1, name: "Thông tin & chính sách" })).toBeVisible();

  for (const topic of buildPolicyHubViewModel().topics) {
    // The anchor is the published contract: a footer link to `/policies#<id>` has to land.
    await expect(page.locator(`#${topic.id}`)).toHaveCount(1);
    await expect(main).toContainText(topic.title);
    await expect(main).toContainText(topic.detail);

    const [path] = topic.href.split("#");
    const destination = await page.request.get(`${BASE_URL}${path}`);
    expect(destination.status(), `${topic.id} points at ${path}`).toBe(200);
  }

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
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

test("U33c the Size Guide page renders every approved chart with its body-measurement semantics", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/size-guide`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1, name: "Hướng dẫn chọn size" })).toBeVisible();

  // Unit cm, circumference semantics, tolerance and guidance visible
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote);

  // §11 splits the units: body measurements and height in cm, weight in kg. Every chart mixes
  // both, so the page must not announce one unit for all of them -- it did, and every table under
  // that heading contradicted it. Units are stated per row and nowhere else.
  await expect(main).not.toContainText(/đơn vị/i);
  for (const chart of PUBLIC_SIZE_GUIDE.charts) {
    const units = new Set(chart.rows.map((row) => row.parameter.match(/\(([^)]+)\)$/)?.[1]));
    expect(units.size, `${chart.id} must state more than one unit`).toBeGreaterThan(1);
    for (const row of chart.rows) {
      await expect(main).toContainText(row.parameter);
    }
  }
  await expect(main).toContainText(PUBLIC_SIZE_GUIDE.guidanceNote);

  // A4: no fixed tolerance applies, so the statement is absent rather than blank or `±0 cm`. A
  // brand that does publish one still has to show it, which is why this follows the config.
  if (PUBLIC_SIZE_GUIDE.tolerance === null) {
    await expect(main).not.toContainText("Dung sai");
  } else {
    await expect(main).toContainText(PUBLIC_SIZE_GUIDE.tolerance.note);
    await expect(main).toContainText(describePublicSizeTolerance() as string);
  }

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
