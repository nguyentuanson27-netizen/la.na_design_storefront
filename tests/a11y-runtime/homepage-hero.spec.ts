import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

/**
 * F6a — the homepage hero across its three approved states (master spec §17).
 *
 * The states are driven by real rows rather than by injected props, because this repository has no
 * component harness: if the slider could only be exercised by a unit test that never renders it,
 * "autoplay pauses on hover" would be an assertion about a mock. Each case writes the collections
 * whose hero media the homepage maps into slides, then reloads.
 *
 * Autoplay is observed through `data-autoplaying` rather than by waiting six seconds for the slide
 * to change: the attribute is the component's own answer to "is the timer running", so a test that
 * reads it fails when the pause rule breaks instead of when the machine is slow.
 */

const HOST = "127.0.0.1";
const PORT = 3232;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TEST_PREFIX = "f6a-hero-";

const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

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
      throw new Error(`Next.js F6a hero server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which requests Better Auth's catch-all route
      // as soon as it hydrates. A page-only readiness probe can win the race against a freshly
      // started `next dev` and let Playwright navigate while that route still answers a transient
      // 404, which the browser's clean-console guard then correctly records. Declare the fixture
      // ready only once the page and the route it immediately depends on are both live; the
      // assertion itself stays strict.
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for F6a hero server\n${serverOutput}`);
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
    await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  }
  server = undefined;
}

/** Park every real published/positioned collection, so only this spec's rows reach the hero. */
async function prepareCollectionState() {
  await prisma.collectionDefinition.deleteMany({ where: { slug: { startsWith: TEST_PREFIX } } });

  originalCollectionState = await prisma.collectionDefinition.findMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    select: { slug: true, isPublished: true, homepagePosition: true },
  });

  await prisma.collectionDefinition.updateMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    data: { isPublished: false, homepagePosition: null },
  });
}

async function restoreCollectionState() {
  await prisma.collectionDefinition.deleteMany({ where: { slug: { startsWith: TEST_PREFIX } } });

  for (const state of originalCollectionState) {
    await prisma.collectionDefinition.update({
      where: { slug: state.slug },
      data: { isPublished: state.isPublished, homepagePosition: state.homepagePosition },
    });
  }
}

async function clearHeroSlides() {
  await prisma.collectionDefinition.deleteMany({ where: { slug: { startsWith: TEST_PREFIX } } });
}

async function addHeroSlide(index: number, heroImageUrl: string | null) {
  await prisma.collectionDefinition.create({
    data: {
      slug: `${TEST_PREFIX}${index}`,
      title: `F6a Hero ${index}`,
      description: `F6a hero fixture ${index}.`,
      isPublished: true,
      homepagePosition: index,
      heroImageUrl,
      pancakeCategoryIds: [],
    },
  });
}

const hero = (page: Page) => page.getByRole("region", { name: "Ảnh bìa trang chủ" });
const dots = (page: Page) => page.getByRole("button", { name: /^Ảnh bìa \d+$/ });

test.beforeAll(async () => {
  await prepareCollectionState();
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock file
      // there. Every spec drives this one project, so they share that lock unless each gets
      // its own directory -- and a server that has to be SIGKILLed leaves the lock behind,
      // which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/homepage-hero",
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

test.beforeEach(async ({ page }) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
});

test("F6a zero slides omit the hero entirely rather than render an empty carousel", async ({
  page,
}) => {
  await clearHeroSlides();
  // A published, positioned collection with no hero image must contribute no slide: absence of
  // media is absence of a slide, not a slide with a placeholder behind it.
  await addHeroSlide(1, null);

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await expect(hero(page)).toHaveCount(0);
  await expect(dots(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Khám phá thiết kế" })).toHaveCount(0);
  // The page still has exactly one h1, which the hero never carried.
  await expect(page.locator("h1")).toHaveCount(1);
});

test("F6a one slide renders a stable static hero with no slider controls", async ({ page }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const region = hero(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveClass(/home-hero--static/);
  await expect(region.locator("img")).toBeVisible();

  const cta = region.getByRole("link", { name: "Khám phá thiết kế" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", `/collections/${TEST_PREFIX}1`);

  // One slide is not a carousel: no dots, and nothing claiming to autoplay.
  await expect(dots(page)).toHaveCount(0);
  await expect(region).not.toHaveAttribute("data-autoplaying", /.*/);
});

test("F6a three slides autoplay, pause on hover, and expose dots but no arrows", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");
  await addHeroSlide(3, "https://content.pancake.vn/1/2/3/4/hero-three.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const region = hero(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveClass(/home-hero--slider/);
  await expect(dots(page)).toHaveCount(3);
  await expect(region).toHaveAttribute("data-autoplaying", "true");

  // §17 rules out arrow controls; the only buttons in the region are the dots.
  await expect(region.getByRole("button")).toHaveCount(3);

  // Exactly one slide is exposed at a time, so the keyboard walks one CTA rather than three.
  await expect(region.getByRole("link", { name: "Khám phá thiết kế" })).toHaveCount(1);

  await region.hover();
  await expect(region).toHaveAttribute("data-autoplaying", "false");

  await page.mouse.move(0, 0);
  await expect(region).toHaveAttribute("data-autoplaying", "true");
});

test("F6a a dot takes the shopper over and stops autoplay for good", async ({ page }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const region = hero(page);
  await expect(dots(page).nth(0)).toHaveAttribute("aria-current", "true");

  await dots(page).nth(1).click();

  await expect(dots(page).nth(1)).toHaveAttribute("aria-current", "true");
  await expect(dots(page).nth(0)).toHaveAttribute("aria-current", "false");
  await expect(
    region.getByRole("link", { name: "Khám phá thiết kế" }),
  ).toHaveAttribute("href", `/collections/${TEST_PREFIX}2`);

  // Moving the pointer away must not restart a slider the shopper has taken over.
  await page.mouse.move(0, 0);
  await expect(region).toHaveAttribute("data-autoplaying", "false");
});

test("F6a a horizontal drag advances the hero", async ({ page }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const track = page.locator(".home-hero__track");
  const box = await track.boundingBox();
  if (!box) throw new Error("Expected the hero track to have a layout box");

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
  await page.mouse.up();

  await expect(dots(page).nth(1)).toHaveAttribute("aria-current", "true");

  // A drag shorter than the threshold is a tap, and must not move the hero.
  await dots(page).nth(0).click();
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 - 10, y, { steps: 4 });
  await page.mouse.up();

  await expect(dots(page).nth(0)).toHaveAttribute("aria-current", "true");
});

test("F6a reduced motion never starts autoplay, and leaves the dots usable", async ({ browser }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const region = hero(page);
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("data-autoplaying", "false");

    // Reduced motion removes the movement, not the navigation.
    await dots(page).nth(1).click();
    await expect(dots(page).nth(1)).toHaveAttribute("aria-current", "true");
  } finally {
    await context.close();
  }
});
