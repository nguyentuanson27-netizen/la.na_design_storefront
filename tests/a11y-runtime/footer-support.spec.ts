import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BRAND, NAVIGATION } from "../../src/brand/index.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../../src/content/public-brand-facts.ts";
import { POLICY_HUB_TOPICS } from "../../src/routes/evergreen-model.ts";

const HOST = "127.0.0.1";
const PORT = 3317;
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
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/footer-support",
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

  const brandHome = footer.getByRole("link", { name: BRAND.identity.name, exact: true });
  await expect(brandHome).toBeVisible();
  const masterLogo = brandHome.getByRole("img", { name: BRAND.identity.name, exact: true });
  await expect(masterLogo).toHaveAttribute("src", /\/_next\/image\?url=%2Fbrand%2Fla-na-design-master-logo\.png/);
  await expect(masterLogo).toHaveAttribute("sizes", "176px");
  await masterLogo.scrollIntoViewIfNeeded();
  await expect(masterLogo).toBeVisible();
  await expect.poll(() =>
    masterLogo.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  const renderedLogo = await masterLogo.evaluate((image) => {
    const element = image as HTMLImageElement;
    return {
      complete: element.complete,
      naturalWidth: element.naturalWidth,
      currentSrc: element.currentSrc,
    };
  });
  expect(renderedLogo.complete).toBe(true);
  expect(renderedLogo.naturalWidth).toBeLessThan(4185);
  expect(renderedLogo.currentSrc).toContain("/_next/image?url=%2Fbrand%2Fla-na-design-master-logo.png");

  // The owner-approved source asset remains byte-preserved and directly reachable; presentation
  // simply stops shipping all 4,185 source pixels to a logo rendered at 11rem.
  const masterLogoResponse = await page.request.get(`${BASE_URL}/brand/la-na-design-master-logo.png`);
  expect(masterLogoResponse.status()).toBe(200);
  expect(masterLogoResponse.headers()["content-type"]).toContain("image/png");

  await expect(footer).toContainText(BRAND.identity.strapline);

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
  const supportTopics = POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "support");
  const policyTopics = POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "policy");
  expect(supportTopics.length + policyTopics.length).toBe(POLICY_HUB_TOPICS.length);

  for (const topic of supportTopics) {
    await expect(support.getByRole("link", { name: topic.title, exact: true })).toHaveAttribute("href", topic.href);
  }
  for (const topic of policyTopics) {
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
  // The owner released the representative for this block. It renders from the same projection as
  // the rest, so the assertion reads the fact rather than repeating the name.
  await expect(legal).toContainText(
    `Đại diện pháp luật: ${PUBLIC_LEGAL_FACTS.legalRepresentative}`,
  );

  await expect(footer.locator('a[href="/lookbook"]')).toHaveCount(0);
  await expect(footer.locator('a[href="/flash-sale"]')).toHaveCount(0);
  await expect(footer.getByText(/newsletter/i)).toHaveCount(0);
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

  // Mobile collapses the three link columns into disclosures -- the owner's replacement for the
  // original always-expanded mobile footer -- and keeps them usable with no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("footer [data-footer-group]")).toHaveCount(4);
  // Still no <details>: the disclosure is a button whose expanded state React owns, so the
  // panel's visibility and `aria-expanded` cannot disagree.
  await expect(page.locator("footer details, footer summary")).toHaveCount(0);

  const mobileColumns = await page.locator("footer .footer-groups").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  expect(mobileColumns).toBe(1);

  const mobileGroups = [
    { heading: "Mua sắm", navigation: "Mua sắm", firstLink: "Áo dài" },
    { heading: "Hỗ trợ khách hàng", navigation: "Hỗ trợ khách hàng", firstLink: supportTopics[0]!.title },
    { heading: "Thông tin & chính sách", navigation: "Thông tin và chính sách", firstLink: policyTopics[0]!.title },
  ] as const;

  for (const group of mobileGroups) {
    const toggle = page.locator("footer").getByRole("button", { name: group.heading, exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator("footer").getByRole("link", { name: group.firstLink, exact: true }),
    ).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("navigation", { name: group.navigation });
    await expect(panel).toBeVisible();

    const linkHeights = await panel.getByRole("link").evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height),
    );
    expect(linkHeights.length).toBeGreaterThan(0);
    expect(linkHeights.every((height) => height >= 44), group.heading).toBe(true);

    // One at a time is not the rule; closing again is, so the collapsed footer stays collapsed.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }

  // The brand column is not a disclosure: its contact details are the footer's point.
  const brandTargets = await page
    .locator("footer .footer-group--brand a")
    .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
  expect(brandTargets.length).toBeGreaterThan(0);
  expect(brandTargets.every((height) => height >= 44)).toBe(true);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("F9a mobile footer without JavaScript keeps every link and ships no disclosure a visitor cannot open", async ({
  browser,
}) => {
  // The disclosure is a React button, so with scripting disabled it could never open. §33's
  // guarantee is that such a visitor keeps every link, which the hydrating tests above cannot
  // observe: by the time they click, the page has hydrated and the button works.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(`${BASE_URL}/search`, { waitUntil: "load" });
    expect(response?.status()).toBe(200);

    const footer = page.locator("footer");
    await expect(footer).toBeVisible();

    // No dead controls: a button that cannot do anything must not be in the page at all.
    await expect(footer.getByRole("button")).toHaveCount(0);

    for (const group of ["Mua sắm", "Hỗ trợ khách hàng", "Thông tin & chính sách"]) {
      await expect(footer.getByRole("heading", { level: 2, name: group, exact: true })).toBeVisible();
    }

    // Every destination the hydrated footer hides behind a disclosure is reachable here.
    const expectedShopping = NAVIGATION.footer;
    const supportTopics = POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "support");
    const policyTopics = POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "policy");
    const expected = [
      ...expectedShopping.map((item) => ({ label: item.label, href: item.href })),
      ...supportTopics.map((topic) => ({ label: topic.title, href: topic.href })),
      ...policyTopics.map((topic) => ({ label: topic.title, href: topic.href })),
    ];
    expect(expected.length).toBeGreaterThan(0);

    for (const { label, href } of expected) {
      const link = footer.getByRole("link", { name: label, exact: true });
      await expect(link, label).toBeVisible();
      await expect(link, label).toHaveAttribute("href", href);
    }

    // The panels are genuinely laid out, not merely present in the accessibility tree.
    const panelDisplays = await page
      .locator("footer .footer-panel")
      .evaluateAll((panels) => panels.map((panel) => getComputedStyle(panel).display));
    expect(panelDisplays).toHaveLength(3);
    expect(panelDisplays.every((display) => display !== "none")).toBe(true);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

/**
 * The footer's layout, at the three widths the owner reads it at.
 *
 * Two findings. The contact facts were a two-row grid per fact -- label above, value below -- so a
 * two-word fact took two lines, and the rows carrying a link were a full `--control-height` tall
 * while the address and hours rows were one line, which is where the uneven rhythm came from. And
 * the three link columns were each sized `1fr` of the whole footer, so they sat a third of the
 * viewport apart and read as three unrelated regions rather than one navigation block.
 *
 * What is pinned here is the relationship rather than a measurement: every contact row is one line
 * box in one inline flow, the gaps between them are all the same, and the three link columns are
 * equal, close together, and in the right-hand part of the footer. Wrapping is allowed where the
 * text genuinely does not fit -- it must just not come from a label and its value being separate
 * blocks.
 */
const CONTACT_WIDTHS = [
  { name: "320", width: 320, height: 800 },
  { name: "390", width: 390, height: 844 },
  // Boundary regression: the fixed 16rem desktop tracks must not overflow immediately above the
  // legacy 900px breakpoint.
  { name: "901", width: 901, height: 900 },
  { name: "1440", width: 1440, height: 900 },
] as const;

for (const viewport of CONTACT_WIDTHS) {
  test(`footer contact facts are one inline flow with an even rhythm at ${viewport.name}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const footer = page.locator("footer.site-footer");
    await footer.scrollIntoViewIfNeeded();

    const rows = page.locator(".footer-contact-list > li");
    await expect(rows).toHaveCount(5);

    // Label and value share one line box. Reading the rendered text is what separates "inline" from
    // "two blocks that happen to look close together": a grid row would put a newline between them.
    await expect(rows.nth(0)).toHaveText(/^Hotline\/Zalo:\s*\d+$/);
    await expect(rows.nth(1)).toHaveText(/^Email hỗ trợ:\s*\S+@\S+$/);
    await expect(rows.nth(3)).toHaveText(/^Giờ hỗ trợ:\s*\S.*$/);

    const metrics = await rows.evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(item).lineHeight);
        return {
          top: rect.top,
          bottom: rect.bottom,
          lines: Math.round(rect.height / lineHeight),
        };
      }),
    );

    // Equal spacing is the finding. Compare the gaps to each other rather than to a constant, so
    // the assertion survives a change of token but not a row that inflates itself.
    const gaps = metrics
      .slice(1)
      .map((row, index) => Number((row.top - metrics[index]!.bottom).toFixed(1)));
    for (const gap of gaps) {
      expect(Math.abs(gap - gaps[0]!), `gaps: ${gaps.join(", ")}`).toBeLessThanOrEqual(0.5);
    }

    // Every row is a single line except where the text genuinely cannot fit, which only the address
    // reaches and only on the narrowest phone.
    for (const [index, row] of metrics.entries()) {
      const allowed = index === 2 && viewport.width <= 320 ? 2 : 1;
      expect(row.lines, `row ${index} at ${viewport.name}px`).toBeLessThanOrEqual(allowed);
    }

    // The links keep a full control-height hit area even though their rows are one line tall --
    // the point of making them inline with vertical padding rather than shrinking the target.
    for (const selector of ['a[href^="tel:"]', 'a[href^="mailto:"]']) {
      const box = await footer.locator(selector).first().boundingBox();
      expect(box!.height, selector).toBeGreaterThanOrEqual(44);
    }

    // ...and two adjacent hit areas must not overlap, or a tap between the phone and the email
    // lands on whichever happens to paint last.
    const linkRects = await footer
      .locator('.footer-contact-list a[href^="tel:"], .footer-contact-list a[href^="mailto:"]')
      .evaluateAll((links) =>
        links.map((link) => {
          const rect = link.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
      );
    for (const [index, rect] of linkRects.slice(1).entries()) {
      expect(rect.top, "tel/mailto hit areas overlap").toBeGreaterThanOrEqual(
        linkRects[index]!.bottom - 0.5,
      );
    }
    await expect(
      footer.locator(`a[href="tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}"]`),
    ).toBeVisible();
    await expect(footer.locator(`a[href="mailto:${PUBLIC_CONTACT_FACTS.email}"]`)).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${viewport.name}px`).toBeLessThanOrEqual(1);
  });
}

test("the three footer link columns read as one cluster on the right at desktop width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const footer = page.locator("footer.site-footer");
  await footer.scrollIntoViewIfNeeded();

  const columns = await page
    .locator("footer .footer-group:not(.footer-group--brand)")
    .evaluateAll((groups) =>
      groups.map((group) => {
        const rect = group.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }),
    );
  expect(columns).toHaveLength(3);

  const footerWidth = (await footer.boundingBox())!.width;

  // One cluster: the columns are the same width and the space between them is the same gap twice,
  // not two different amounts of leftover room.
  for (const column of columns) {
    expect(Math.abs(column.width - columns[0]!.width)).toBeLessThanOrEqual(1);
  }
  const columnGaps = [columns[1]!.left - columns[0]!.right, columns[2]!.left - columns[1]!.right];
  expect(Math.abs(columnGaps[0]! - columnGaps[1]!)).toBeLessThanOrEqual(1);

  // ...and a tight one. Sized `1fr` each, the gaps were a third of the viewport; the cluster is now
  // narrower than the footer's right-hand half plus a margin of tolerance.
  expect(columnGaps[0]!).toBeLessThanOrEqual(footerWidth * 0.05);

  // The cluster sits in the right-hand part of the footer, with the brand block to its left.
  const clusterStart = columns[0]!.left / footerWidth;
  const clusterEnd = columns[2]!.right / footerWidth;
  expect(clusterStart).toBeGreaterThan(0.33);
  expect(clusterStart).toBeLessThan(0.5);
  expect(clusterEnd).toBeGreaterThan(0.9);

  const brand = (await page.locator("footer .footer-group--brand").boundingBox())!;
  expect(brand.x).toBeLessThan(columns[0]!.left);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The legal block below is untouched by the layout change.
  const legal = page.locator("[data-footer-legal]");
  await expect(legal).toContainText(PUBLIC_LEGAL_FACTS.legalEntityName);
  await expect(legal).toContainText(
    `Đại diện pháp luật: ${PUBLIC_LEGAL_FACTS.legalRepresentative}`,
  );

  const results = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
