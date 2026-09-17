import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags.ts";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";
import { SEO_LENGTH_GUIDANCE } from "../../src/commerce/seo-length-guidance.ts";

const HOST = "127.0.0.1";
const PORT = 3212;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

/**
 * I3 — the shop the spawned server is configured for.
 *
 * Pinned in the spawn env rather than inherited, because the selling-policy boundary refuses a
 * product that is not a visible product of THIS shop (I2). The older fixtures in this file predate
 * that and sit on the schema default of 0, which is why only the I3 products are seeded here.
 */
const SHOP_ID = 920_012;

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-a11y-${runId}@example.invalid`;
const password = "admin-a11y-runtime-password-123";
const productExternalId = `admin-a11y-product-${runId}`;
const productSlug = `admin-a11y-product-${runId}`;
const editedProductSlug = `ao-so-mi-admin-${runId}`;
const productName = `Admin A11y Product ${runId}`;
const parentExternalId = `admin-a11y-parent-${runId}`;
const parentSlug = `admin-a11y-parent-${runId}`;
const parentName = `Admin Composite Parent ${runId}`;
const pairHolderExternalId = `admin-a11y-pair-holder-${runId}`;
const pairRivalExternalId = `admin-a11y-pair-rival-${runId}`;
const pairSeoTitle = `Áo Oxford Relaxed ${runId}`;
const pairSeoDescription = `Áo Oxford Relaxed của LA Clothing — ${runId}.`;
const sourceDescription = "Read-only Pancake source context for editorial decisions.";
const policyExternalId = `admin-a11y-policy-${runId}`;
const policyParentExternalId = `admin-a11y-policy-parent-${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let productId = "";
let parentProductId = "";
let policyProductId = "";
let policyParentProductId = "";
let parentVariantId = "";
let componentVariantId = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) {
      throw new Error("Better Auth returned a malformed Set-Cookie header");
    }
    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: BASE_URL,
    };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js a11y server exited with ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js a11y server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    once(server, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  if (await waitForServerExit(5_000)) return;
  server.kill("SIGKILL");
  await waitForServerExit(5_000);
}

async function cleanupDatabase() {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.productMirror.deleteMany({
    where: {
      pancakeProductId: {
        in: [
        productExternalId,
        parentExternalId,
        pairHolderExternalId,
        pairRivalExternalId,
        policyExternalId,
        policyParentExternalId,
      ],
      },
    },
  });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  const syncedAt = new Date();
  const product = await prisma.productMirror.create({
    data: {
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: productName,
      sourceDescription,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  productId = product.id;

  const componentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-a11y-component-m-${runId}`,
      productId,
      sku: "CHILD-M",
      size: "M",
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  componentVariantId = componentVariant.id;

  await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-a11y-component-l-unlinked-${runId}`,
      productId,
      sku: "CHILD-L",
      size: "L",
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });

  const parent = await prisma.productMirror.create({
    data: {
      pancakeProductId: parentExternalId,
      slug: parentSlug,
      name: parentName,
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  parentProductId = parent.id;

  const parentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-a11y-parent-m-${runId}`,
      productId: parent.id,
      sku: "SET-PARENT-M",
      size: "M",
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  parentVariantId = parentVariant.id;

  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId,
      componentVariantId,
      quantity: 1,
      syncedAt,
    },
  });

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.21" }),
    body: {
      name: "Admin A11y Runtime",
      email: adminEmail,
      password,
    },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);

  await prisma.user.update({
    where: { email: adminEmail },
    data: { role: "ADMIN" },
  });

  // I3 — seeded at SHOP_ID so the selling-policy boundary's shop scope (I2) is satisfied. An
  // ordinary product and a composite parent, because §11's refusal is half of what the editor has
  // to surface.
  const policyProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: policyExternalId,
      slug: policyExternalId,
      name: `Admin Policy Product ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
    },
    select: { id: true },
  });
  policyProductId = policyProduct.id;

  const policyParent = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: policyParentExternalId,
      slug: policyParentExternalId,
      name: `Admin Policy Set ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
      variants: {
        create: {
          pancakeVariationId: `${policyParentExternalId}-parent`,
          isPresent: true,
          isActive: true,
          syncedAt: new Date(),
        },
      },
    },
    select: { id: true, variants: { select: { id: true } } },
  });
  policyParentProductId = policyParent.id;

  const policyComponent = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${policyExternalId}-component`,
      productId: policyProductId,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
    },
    select: { id: true },
  });
  // The component edge is what makes the parent a composite for §11's purposes.
  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId: policyParent.variants[0]!.id,
      componentVariantId: policyComponent.id,
      quantity: 1,
      syncedAt: new Date(),
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PANCAKE_SHOP_ID: String(SHOP_ID) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
  await cleanupDatabase();
  await prisma.$disconnect();
});

test("admin editor keeps Pancake source read-only and manages unified ordinary/composite activation accessibly", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      browserErrors.push(`console: ${message.text()} @ ${location.url || "unknown"}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(productId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Website commerce" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Biến thể website" })).toBeVisible();
  const sourceDisclosure = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Nguồn Pancake" }),
  });
  await expect(sourceDisclosure).not.toHaveAttribute("open", "");
  await expect(sourceDisclosure.locator("summary")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Nguồn mô tả từ Pancake" })).toBeHidden();
  await expect(page.getByText(sourceDescription, { exact: true })).toBeHidden();
  await sourceDisclosure.locator("summary").click();
  await expect(page.getByRole("heading", { level: 2, name: "Nguồn mô tả từ Pancake" })).toBeVisible();
  await expect(page.getByText(sourceDescription, { exact: true })).toBeVisible();
  await expect(sourceDisclosure.getByRole("button", { name: /^(Kích hoạt|Tắt) biến thể/ })).toHaveCount(0);
  await expect(page.locator('[name="sourceDescription"]')).toHaveCount(0);
  const slugTextbox = page.getByRole("textbox", { name: "Slug sản phẩm", exact: true });
  await expect(slugTextbox).toHaveValue(productSlug);
  await expect(page.getByRole("button", { name: "Lưu slug" })).toBeVisible();
  await expect(page.getByLabel("Trạng thái xuất bản")).toHaveValue("DRAFT");
  await expect(page.getByRole("button", { name: "Lưu nội dung" })).toBeVisible();
  await expect(page.getByLabel("Mô tả biên tập")).toBeVisible();
  await expect(page.getByLabel("SEO title")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);

  const componentRow = page.getByRole("row").filter({ hasText: "CHILD-M" }).first();
  await expect(componentRow.getByText("Thành phần set", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: parentName })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Kích hoạt biến thể CHILD-L" }),
  ).toBeVisible();

  await componentRow.getByRole("button", { name: "Kích hoạt biến thể CHILD-M" }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("variantSaved") === "1",
  );
  const childSuccessStatus = page
    .getByRole("status")
    .filter({ hasText: "Đã cập nhật trạng thái biến thể website." });
  await expect(childSuccessStatus).toBeVisible();
  await expect(childSuccessStatus).toBeFocused();

  const activated = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: componentVariantId },
    select: {
      isActive: true,
      product: { select: { isActive: true } },
    },
  });
  expect(activated).toEqual({
    isActive: true,
    product: { isActive: false },
  });

  const parentEditorPath = `/admin/products/${encodeURIComponent(parentProductId)}`;
  await page.goto(`${BASE_URL}${parentEditorPath}`, { waitUntil: "networkidle" });
  const parentSourceDisclosure = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Nguồn Pancake" }),
  });
  await expect(parentSourceDisclosure).not.toHaveAttribute("open", "");
  await parentSourceDisclosure.locator("summary").click();
  const childReferenceRow = page.getByRole("row").filter({ hasText: productName });
  await expect(childReferenceRow.getByText("Đã kích hoạt biến thể", { exact: true })).toBeVisible();
  await expect(childReferenceRow.getByText("Catalog riêng: tắt", { exact: true })).toBeVisible();
  await expect(childReferenceRow.getByRole("button")).toHaveCount(0);

  const parentVariantRow = page.getByRole("row").filter({ hasText: "SET-PARENT-M" }).first();
  await expect(parentVariantRow.getByText("Set cha", { exact: true })).toBeVisible();
  const parentActivationButton = parentVariantRow.getByRole("button", {
    name: "Kích hoạt biến thể SET-PARENT-M",
  });
  await expect(parentActivationButton).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  const parentAccessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(parentAccessibilityScan.violations).toEqual([]);

  await parentActivationButton.click();
  await page.waitForURL(
    (url) => url.pathname === parentEditorPath && url.searchParams.get("variantSaved") === "1",
  );
  const parentSuccessStatus = page
    .getByRole("status")
    .filter({ hasText: "Đã cập nhật trạng thái biến thể website." });
  await expect(parentSuccessStatus).toBeVisible();
  await expect(parentSuccessStatus).toBeFocused();
  expect(
    (
      await prisma.variantMirror.findUniqueOrThrow({
        where: { id: parentVariantId },
        select: { isActive: true },
      })
    ).isActive,
  ).toBe(true);

  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });
  await page.getByRole("row").filter({ hasText: "CHILD-M" }).first().getByRole("button", {
    name: "Tắt biến thể CHILD-M",
  }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("variantSaved") === "1",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Đã cập nhật trạng thái biến thể website." }),
  ).toBeFocused();
  expect(
    (
      await prisma.variantMirror.findUniqueOrThrow({
        where: { id: componentVariantId },
        select: { isActive: true },
      })
    ).isActive,
  ).toBe(false);

  await slugTextbox.fill(`  Áo Sơ Mi Admin ${runId}  `);
  await page.getByRole("button", { name: "Lưu slug" }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("slugSaved") === "1",
  );
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu slug sản phẩm." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Slug sản phẩm", exact: true })).toHaveValue(
    editedProductSlug,
  );

  const persistedSlug = await prisma.productMirror.findUniqueOrThrow({
    where: { id: productId },
    select: { slug: true },
  });
  expect(persistedSlug.slug).toBe(editedProductSlug);
  const slugHistory = await prisma.productSlugHistory.findUniqueOrThrow({
    where: { slug: productSlug },
    select: { productId: true },
  });
  expect(slugHistory.productId).toBe(productId);

  await page.getByLabel("Trạng thái xuất bản").selectOption("PUBLISHED");
  await page.getByLabel("Mô tả biên tập").fill("Editorial content verified in a real browser.");
  await page.getByLabel("Hướng dẫn bảo quản").fill("Cold wash. Dry in shade.");
  await page.locator('select[name="sizeGuide"]').selectOption("set-vay-form-rong");
  await page.getByLabel("SEO title").fill("Accessible admin editor");
  await page.getByLabel("SEO description").fill("Browser runtime verification.");

  const saveButton = page.getByRole("button", { name: "Lưu nội dung" });
  await saveButton.click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("saved") === "1",
  );
  const successStatus = page.getByRole("status");
  await expect(successStatus).toContainText("Đã lưu nội dung biên tập.");
  await expect(successStatus).toBeFocused();

  const persisted = await prisma.productContent.findUnique({
    where: { productId },
    select: { status: true, editorialDescription: true, seoTitle: true, sizeGuide: true },
  });
  expect(persisted).toEqual({
    status: "PUBLISHED",
    editorialDescription: "Editorial content verified in a real browser.",
    seoTitle: "Accessible admin editor",
    sizeGuide: "set-vay-form-rong",
  });
  await expect(page.locator('select[name="sizeGuide"]')).toHaveValue("set-vay-form-rong");
  const sourceAfterSave = await prisma.productMirror.findUnique({
    where: { id: productId },
    select: { sourceDescription: true, slug: true },
  });
  expect(sourceAfterSave).toEqual({ sourceDescription, slug: editedProductSlug });

  // U34a / W16. The length readout is advice, and the proof is that copy past it still saves -
  // for both fields, through the real form and Server Action, in one submit. 61 and 156 are each
  // one character past their advisory target: the counters must say so, nothing may be disabled,
  // and both values must persist exactly.
  const overAdvisoryTitle = "A".repeat(SEO_LENGTH_GUIDANCE.seoTitle + 1);
  const overAdvisoryDescription = "D".repeat(SEO_LENGTH_GUIDANCE.seoDescription + 1);
  await page.getByLabel("SEO title").fill(overAdvisoryTitle);
  await page.getByLabel("SEO description").fill(overAdvisoryDescription);

  for (const recommended of [SEO_LENGTH_GUIDANCE.seoTitle, SEO_LENGTH_GUIDANCE.seoDescription]) {
    await expect(page.getByText(`${recommended + 1}/${recommended}`)).toBeVisible();
  }
  await expect(page.getByText("dài hơn khuyến nghị, vẫn lưu được.")).toHaveCount(2);

  const advisorySaveButton = page.getByRole("button", { name: "Lưu nội dung" });
  await expect(advisorySaveButton).toBeEnabled();
  await advisorySaveButton.click();
  // The URL already carries ?saved=1 from the save above, so waiting on it would match instantly
  // and read the database before this save landed. Wait for the outcome itself instead.
  await expect
    .poll(
      async () =>
        await prisma.productContent.findUnique({
          where: { productId },
          select: { seoTitle: true, seoDescription: true },
        }),
      { message: "over-advisory SEO copy must persist exactly as typed, in both fields" },
    )
    .toEqual({ seoTitle: overAdvisoryTitle, seoDescription: overAdvisoryDescription });

  // Server-side validation must reject an oversized value even when the client-side maxlength is
  // bypassed. Since U34a the field is a client component, so React owns the `maxLength` prop and
  // re-applies it on any render after this attribute is removed - which would truncate the value
  // before it ever left the browser. Strip the attribute, set the oversized value and submit in
  // one task, leaving no window for that. What is under test is unchanged: the server's own bound,
  // exercised with 501 characters the browser was not allowed to trim.
  const seoTitle = page.getByLabel("SEO title");
  const errorText = "Không thể lưu. Kiểm tra độ dài và định dạng các trường rồi thử lại.";
  await seoTitle.evaluate((element) => {
    element.removeAttribute("maxlength");
    const input = element as HTMLInputElement;
    input.value = "x".repeat(501);
    input.form?.requestSubmit();
  });
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("error") === "invalid",
  );
  const errorStatus = page.getByRole("alert").filter({ hasText: errorText });
  await expect(errorStatus).toContainText(errorText);
  await expect(errorStatus).toBeFocused();
  expect(
    browserErrors,
    `browser console errors; failed responses: ${JSON.stringify(failedResponses)}`,
  ).toEqual([]);
  expect(failedResponses).toEqual([]);
});

/**
 * B5 / U29 in the real admin flow.
 *
 * The two halves of the contract have to be true of the actual form, not only of the domain: a
 * draft may hold copy a published product already owns and must say so, and the move to
 * `PUBLISHED` must be refused by the server even when the operator ignores that warning — which is
 * exactly what a submit does, since nothing in the browser prevents it.
 */
test("B5 a colliding SEO pair warns on a draft and is refused on publish through the real form", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

  const syncedAt = new Date();
  const holder = await prisma.productMirror.create({
    data: {
      pancakeProductId: pairHolderExternalId,
      slug: pairHolderExternalId,
      name: `Pair Holder ${runId}`,
      isPresent: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          seoTitle: pairSeoTitle,
          seoDescription: pairSeoDescription,
        },
      },
    },
  });
  const rival = await prisma.productMirror.create({
    data: {
      pancakeProductId: pairRivalExternalId,
      slug: pairRivalExternalId,
      name: `Pair Rival ${runId}`,
      isPresent: true,
      syncedAt,
    },
  });

  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(rival.id)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  // Nothing has been typed yet, so there is no pair and nothing to warn about.
  await expect(page.getByText("Cảnh báo trùng SEO.")).toHaveCount(0);

  // The draft keeps the colliding copy: B5 lets a draft duplicate, and the save must succeed.
  await page.getByLabel("Trạng thái xuất bản").selectOption("DRAFT");
  await page.getByLabel("SEO title").fill(pairSeoTitle);
  await page.getByLabel("SEO description").fill(pairSeoDescription);
  await page.getByRole("button", { name: "Lưu nội dung" }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("saved") === "1",
  );
  await expect(page.getByRole("status")).toContainText("Đã lưu nội dung biên tập.");
  expect(
    await prisma.productContent.findUnique({
      where: { productId: rival.id },
      select: { status: true, seoTitle: true },
    }),
  ).toEqual({ status: "DRAFT", seoTitle: pairSeoTitle });

  // The warning is now visible, names the product holding the pair, and gates nothing.
  const warning = page.getByText("Cảnh báo trùng SEO.");
  await expect(warning).toBeVisible();
  await expect(page.getByText(`/${holder.slug}`, { exact: false })).toBeVisible();
  const publishButton = page.getByRole("button", { name: "Lưu nội dung" });
  await expect(publishButton).toBeEnabled();

  // The warning is advice, so it is not announced as an alert and does not take focus.
  await expect(page.getByRole("alert").filter({ hasText: "Cảnh báo trùng SEO." })).toHaveCount(0);
  await expect(warning).not.toBeFocused();
  await page.getByLabel("SEO title").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe(
    "seoDescription",
  );

  const accessibility = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .include("main")
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // Ignoring the warning and submitting `PUBLISHED` is refused server-side, and nothing is written.
  await page.getByLabel("Trạng thái xuất bản").selectOption("PUBLISHED");
  await publishButton.click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("error") === "seo-pair",
  );
  // Next renders its own empty route announcer with role="alert", so filter to the real message.
  const blocked = page
    .getByRole("alert")
    .filter({ hasText: "đã thuộc về một sản phẩm đã publish" });
  await expect(blocked).toContainText("đã thuộc về một sản phẩm đã publish");
  await expect(blocked).toBeFocused();
  expect(
    await prisma.productContent.findUnique({
      where: { productId: rival.id },
      select: { status: true },
    }),
  ).toEqual({ status: "DRAFT" });

  // One field changed is enough: the pair is the unit, so the publish now goes through.
  await page.getByLabel("SEO description").fill(`${pairSeoDescription} Bản khác.`);
  await page.getByLabel("Trạng thái xuất bản").selectOption("PUBLISHED");
  await page.getByRole("button", { name: "Lưu nội dung" }).click();
  await expect
    .poll(
      async () =>
        (
          await prisma.productContent.findUnique({
            where: { productId: rival.id },
            select: { status: true },
          })
        )?.status,
      { message: "a distinct pair must publish" },
    )
    .toBe("PUBLISHED");
  await expect(page.getByText("Cảnh báo trùng SEO.")).toHaveCount(0);

  expect(browserErrors).toEqual([]);
});

/**
 * I3 — the admin surface for ADR 0014 §5's selling mode and negative allowance.
 *
 * Driven through the real form rather than the service, because the thing worth proving here is the
 * one a unit test cannot reach: that an operator's choice actually lands in `ProductSellingPolicy`,
 * and that the §11 composite refusal reaches them as a readable reason instead of a silent no-op.
 */
test("I3 the selling policy editor writes an owner's allowance and refuses it on a set", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(policyProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", { level: 2, name: "Chế độ bán và hạn mức âm" }),
  ).toBeVisible();

  // Unconfigured is a distinct state from configured-to-the-default (§5.1), and the operator is
  // told which one they are looking at.
  await expect(page.getByText("Trạng thái: chưa cấu hình (đang dùng mặc định).")).toBeVisible();

  // The three modes are one mutually exclusive choice, grouped so a screen reader announces the
  // question before the options.
  const modeGroup = page.getByRole("group", { name: "Chế độ bán" });
  await expect(modeGroup).toBeVisible();
  await expect(modeGroup.getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: /Tiêu chuẩn/ })).toBeChecked();

  const limit = page.getByRole("spinbutton", { name: "Hạn mức âm" });
  await expect(limit).toHaveValue("-20");

  await page.getByRole("radio", { name: /Cho phép bán âm/ }).check();
  await limit.fill("-5");
  await page.getByRole("button", { name: "Lưu chế độ bán" }).click();

  await expect(page.getByRole("status")).toContainText("Đã lưu chế độ bán của sản phẩm.");
  // The database is the assertion. A form that reported success without writing would pass every
  // visible check above.
  expect(
    await prisma.productSellingPolicy.findUniqueOrThrow({
      where: { productId: policyProductId },
    }),
  ).toMatchObject({ sellingMode: "OVERSELL", negativeStockLimit: -5 });
  await expect(
    page.getByText("Trạng thái: đã cấu hình — Cho phép bán âm, hạn mức -5."),
  ).toBeVisible();

  // Clearing returns the product to unconfigured, which §5.1 keeps distinct from storing the
  // default values — without this an operator could never undo a review.
  await page.getByRole("button", { name: "Xóa cấu hình, quay lại mặc định" }).click();
  // Waiting on the status banner would match the one the SAVE above already left on the page, and
  // the database check would then run before the clear had landed. The unconfigured line is the
  // state that only exists after this click, so it is what the wait has to be anchored to.
  await expect(page.getByText("Trạng thái: chưa cấu hình (đang dùng mặc định).")).toBeVisible();
  expect(await prisma.productSellingPolicy.count({ where: { productId: policyProductId } })).toBe(0);

  // §11 on the composite parent: the refusal has to arrive as a reason an operator can act on.
  // Storing intent that silently never takes effect is what I2 refuses, and this is where they see
  // it happen.
  const parentEditorPath = `/admin/products/${encodeURIComponent(policyParentProductId)}`;
  await page.goto(`${BASE_URL}${parentEditorPath}`, { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: /Đặt trước/ }).check();
  await page.getByRole("button", { name: "Lưu chế độ bán" }).click();

  // Scoped to this editor's own region: the parent's page carries other alerts, and a page-wide
  // match would both break on strict mode and stop proving WHICH surface reported the refusal.
  const policyRegion = page.getByRole("region", { name: "Chế độ bán và hạn mức âm" });
  await expect(policyRegion.getByRole("alert")).toContainText("Sản phẩm này là set");
  expect(
    await prisma.productSellingPolicy.count({ where: { productId: policyParentProductId } }),
  ).toBe(0);

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});
