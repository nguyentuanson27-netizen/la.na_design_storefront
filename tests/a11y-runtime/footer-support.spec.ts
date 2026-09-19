import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BUYER_AXE_TAGS } from "./axe-tags";
import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../../src/content/public-brand-facts.ts";
import { POLICY_HUB_TOPICS } from "../../src/routes/evergreen-model.ts";

const HOST = "127.0.0.1";
const PORT = 3224;
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
      throw new Error(`U5 footer server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/search`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U5 footer server\n${serverOutput}`);
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

test("F9a footer renders four final groups, canonical destinations and exact legal block", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto(`${BASE_URL}/search`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const footer = page.locator("footer");
  await expect(footer).toBeVisible();

  const groups = footer.locator("[data-footer-group]");
  await expect(groups).toHaveCount(4);
  for (const heading of ["La.na Design", "Mua sắm", "Hỗ trợ khách hàng", "Thông tin & chính sách"]) {
    await expect(footer.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
  }

  // The approved master-logo binary is not present in any accessible repository/project source.
  // This test deliberately does not treat the temporary text wordmark as proof of that blocked
  // acceptance criterion. The PR stays draft until the approved asset can be restored.
  await expect(footer.getByRole("link", { name: "La.na Design", exact: true })).toBeVisible();
  await expect(footer).toContainText("Charismatic in every yard of cloth.");

  // Support facts stay projected from Brand Config rather than repeated in presentation.
  await expect(footer).toContainText(PUBLIC_CONTACT_FACTS.telephone);
  await expect(footer).toContainText(PUBLIC_CONTACT_FACTS.email);
  await expect(footer).toContainText(describePublicAddress());
  await expect(footer).toContainText(describePublicSupportHours());
  await expect(
    footer.locator(`a[href="tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}"]`),
  ).toBeVisible();
  await expect(footer.locator(`a[href="mailto:${PUBLIC_CONTACT_FACTS.email}"]`)).toBeVisible();
  await expect(footer.locator(`a[href="${PUBLIC_CONTACT_FACTS.fanpageUrl}"]`)).toBeVisible();

  const shopping = footer.getByRole("navigation", { name: "Mua sắm" });
  const expectedShopping = [
    ["Áo dài", "/ao-dai"],
    ["Set đồ", "/set-do"],
    ["Váy, đầm", "/vay-dam"],
    ["Hàng mới về", "/new-arrivals"],
    ["Sale", "/sale"],
    ["Bộ sưu tập", "/collections"],
  ] as const;
  for (const [label, href] of expectedShopping) {
    await expect(shopping.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
  }

  const support = footer.getByRole("navigation", { name: "Hỗ trợ khách hàng" });
  const policy = footer.getByRole("navigation", { name: "Thông tin và chính sách" });
  for (const topic of POLICY_HUB_TOPICS.slice(0, 6)) {
    await expect(support.getByRole("link", { name: topic.title, exact: true })).toHaveAttribute("href", topic.href);
  }
  for (const topic of POLICY_HUB_TOPICS.slice(6)) {
    await expect(policy.getByRole("link", { name: topic.title, exact: true })).toHaveAttribute("href", topic.href);
  }

  const desktopColumns = await footer.locator(".footer-groups").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(desktopColumns).toBe(4);

  const firstShoppingLink = shopping.getByRole("link").first();
  await firstShoppingLink.focus();
  const focusOutline = await firstShoppingLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(focusOutline.width).not.toBe("0px");

  const legal = footer.locator("[data-footer-legal]");
  await expect(legal).toContainText(PUBLIC_LEGAL_FACTS.legalEntityName);
  await expect(legal).toContainText(PUBLIC_LEGAL_FACTS.registeredAddress);
  await expect(legal).toContainText(
    `MST: ${PUBLIC_LEGAL_FACTS.taxCode} - ngày cấp: ${PUBLIC_LEGAL_FACTS.taxIdIssueDate}`,
  );
  await expect(legal).toContainText(`Email: ${PUBLIC_LEGAL_FACTS.legalEmail}`);

  await expect(footer.locator('a[href="/lookbook"]')).toHaveCount(0);
  await expect(footer.locator('a[href="/flash-sale"]')).toHaveCount(0);
  await expect(footer.getByText(/newsletter/i)).toHaveCount(0);
  await expect(footer.getByText(/đại diện pháp luật|legal representative/i)).toHaveCount(0);
  await expect(footer.locator("details, summary")).toHaveCount(0);

  // Every active same-origin footer destination must resolve. Fragments are client-side anchors, so
  // request the path portion while preserving the link's configured href in the UI assertion above.
  const internalHrefs = await footer.locator('a[href^="/"]').evaluateAll((links) =>
    [...new Set(links.map((link) => link.getAttribute("href")).filter((href): href is string => Boolean(href)))],
  );
  for (const href of internalHrefs) {
    const path = href.split("#")[0] || "/";
    const destination = await page.request.get(`${BASE_URL}${path}`);
    expect(destination.status(), href).toBeLessThan(400);
  }

  // Tablet keeps the final footer readable without horizontal overflow.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload({ waitUntil: "networkidle" });
  const tabletColumns = await page.locator("footer .footer-groups").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(tabletColumns).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  // Mobile keeps all groups expanded and usable with no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("footer [data-footer-group]")).toHaveCount(4);
  await expect(page.locator("footer details, footer summary")).toHaveCount(0);

  const mobileColumns = await page.locator("footer .footer-groups").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(mobileColumns).toBe(1);

  const footerTargets = await page.locator("footer a").evaluateAll((links) =>
    links.map((link) => link.getBoundingClientRect().height),
  );
  expect(footerTargets.every((height) => height >= 44)).toBe(true);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});
