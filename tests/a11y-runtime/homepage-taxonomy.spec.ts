import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import { BRAND } from "../../src/brand/index.ts";
import { readGuestShippingPolicy } from "../../src/commerce/guest-shipping-policy.ts";
import { buildPublicBrandFacts } from "../../src/content/public-brand-facts.ts";
import { prisma } from "../../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3320;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TEST_PREFIX = "u2-homepage-";
const expectedBrandFacts = buildPublicBrandFacts(readGuestShippingPolicy());

type OriginalCollectionState = {
  slug: string;
  isPublished: boolean;
  homepagePosition: number | null;
};

let server: ChildProcess | undefined;
let serverOutput = "";
let originalCollectionState: OriginalCollectionState[] = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js U2 server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U2 server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
  server = undefined;
}

async function prepareCollectionState() {
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { startsWith: TEST_PREFIX } },
  });

  originalCollectionState = await prisma.collectionDefinition.findMany({
    where: {
      OR: [
        { isPublished: true },
        { homepagePosition: { not: null } },
      ],
    },
    select: {
      slug: true,
      isPublished: true,
      homepagePosition: true,
    },
  });

  await prisma.collectionDefinition.updateMany({
    where: {
      OR: [
        { isPublished: true },
        { homepagePosition: { not: null } },
      ],
    },
    data: {
      isPublished: false,
      homepagePosition: null,
    },
  });
}

async function restoreCollectionState() {
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { startsWith: TEST_PREFIX } },
  });

  for (const state of originalCollectionState) {
    await prisma.collectionDefinition.update({
      where: { slug: state.slug },
      data: {
        isPublished: state.isPublished,
        homepagePosition: state.homepagePosition,
      },
    });
  }
}

async function addCollection(
  slug: string,
  title: string,
  isPublished: boolean,
  homepagePosition: number | null = null,
) {
  await prisma.collectionDefinition.create({
    data: {
      slug,
      title,
      description: `${title} homepage taxonomy fixture.`,
      isPublished,
      homepagePosition,
      pancakeCategoryIds: [],
    },
  });
}

async function expectCanonicalTrustStrip(page: import("@playwright/test").Page) {
  const trustStrip = page.locator('[data-homepage-region="trust-support"]');
  await expect(trustStrip).toBeVisible();
  // Master spec §23's brand-story paragraph is its own approved fact, distinct from the tagline
  // every other route inherits, so the homepage quotes it rather than the tagline.
  await expect(trustStrip.getByText(BRAND.identity.homeBrandStory, { exact: true })).toBeVisible();
  await expect(
    trustStrip.getByText(
      `${expectedBrandFacts.paymentMethod} ${expectedBrandFacts.checkoutAccount}`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    trustStrip.getByText(
      `${expectedBrandFacts.shipping.title}. ${expectedBrandFacts.shipping.detail}`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(trustStrip.getByText(expectedBrandFacts.serverVerification, { exact: true })).toBeVisible();

  const supportHrefs = await trustStrip
    .getByRole("navigation", { name: "Hỗ trợ và khám phá" })
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(supportHrefs).toEqual(["/shop", "/collections", "/track-order"]);
}

test.beforeAll(async () => {
  await prepareCollectionState();
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/homepage-taxonomy",
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
      PANCAKE_SHOP_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
  await restoreCollectionState();
  await prisma.$disconnect();
});

test("U2 homepage collection rail uses explicit published merchandising positions across 0, partial and six-slot states", async ({
  page,
}) => {
  await addCollection(`${TEST_PREFIX}unpositioned`, "U2 Published Unpositioned", true);
  await addCollection(`${TEST_PREFIX}draft`, "U2 Draft Positioned", false, 1);

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" })).toHaveCount(0);
  await expect(page.getByText("U2 Published Unpositioned", { exact: true })).toHaveCount(0);
  await expect(page.getByText("U2 Draft Positioned", { exact: true })).toHaveCount(0);
  // No collection here publishes hero media, so the homepage hero stays absent (master spec §17).
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);
  await expectCanonicalTrustStrip(page);
  expect(
    await page.locator("[data-homepage-region]").evaluateAll((regions) =>
      regions.map((region) => region.getAttribute("data-homepage-region")),
    ),
  ).toEqual(["new-arrivals", "service", "trust-support"]);

  await addCollection(`${TEST_PREFIX}a-six`, "U2 Position Six", true, 6);
  await addCollection(`${TEST_PREFIX}z-two`, "U2 Position Two", true, 2);

  await page.reload({ waitUntil: "networkidle" });
  const partialRail = page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" });
  await expect(partialRail).toBeVisible();
  await expect(partialRail.getByRole("link")).toHaveCount(2);
  await expect(partialRail.getByRole("link").nth(0)).toHaveText("U2 Position Two");
  await expect(partialRail.getByRole("link").nth(0)).toHaveAttribute(
    "href",
    `/collections/${TEST_PREFIX}z-two`,
  );
  await expect(partialRail.getByRole("link").nth(1)).toHaveText("U2 Position Six");
  await expect(partialRail.getByRole("link").nth(1)).toHaveAttribute(
    "href",
    `/collections/${TEST_PREFIX}a-six`,
  );
  await expect(page.getByText("U2 Published Unpositioned", { exact: true })).toHaveCount(0);
  await expect(page.getByText("U2 Draft Positioned", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
  await expectCanonicalTrustStrip(page);
  expect(
    await page.locator("[data-homepage-region]").evaluateAll((regions) =>
      regions.map((region) => region.getAttribute("data-homepage-region")),
    ),
  ).toEqual(["new-arrivals", "collection-navigation", "service", "trust-support"]);

  await prisma.collectionDefinition.update({
    where: { slug: `${TEST_PREFIX}draft` },
    data: { homepagePosition: null },
  });
  await addCollection(`${TEST_PREFIX}position-one`, "U2 Position One", true, 1);
  await addCollection(`${TEST_PREFIX}position-three`, "U2 Position Three", true, 3);
  await addCollection(`${TEST_PREFIX}position-four`, "U2 Position Four", true, 4);
  await addCollection(`${TEST_PREFIX}position-five`, "U2 Position Five", true, 5);

  await page.reload({ waitUntil: "networkidle" });
  const fullRail = page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" });
  await expect(fullRail.getByRole("link")).toHaveCount(6);
  await expect(fullRail.getByRole("link").allTextContents()).resolves.toEqual([
    "U2 Position One",
    "U2 Position Two",
    "U2 Position Three",
    "U2 Position Four",
    "U2 Position Five",
    "U2 Position Six",
  ]);
  await expect(page.getByText("U2 Published Unpositioned", { exact: true })).toHaveCount(0);
  await expect(page.getByText("U2 Draft Positioned", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
  await expectCanonicalTrustStrip(page);
});
