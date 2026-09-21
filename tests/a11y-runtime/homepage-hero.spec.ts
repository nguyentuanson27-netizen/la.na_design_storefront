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
const SHOP_ID = 920_032;

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
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_URL: BASE_URL,
      SEARCH_INDEXING_ENABLED: "false",
      NEXT_TELEMETRY_DISABLED: "1",
      PANCAKE_SHOP_ID: String(SHOP_ID),
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

test("owner hero zero-state omits overlay and keeps the header cream", async ({ page }) => {
  await clearHeroSlides();
  await addHeroSlide(1, null);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await expect(hero(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "MUA NGAY" })).toHaveCount(0);
  const background = await page.locator("header.site-header").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
});

test("one slide is a static full-bleed hero with one per-slide MUA NGAY link and no controls", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const region = hero(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveClass(/home-hero--static/);
  await expect(region).toHaveAttribute("data-header-overlay-hero", "");
  await expect(region.getByRole("button")).toHaveCount(0);
  await expect(region).not.toHaveAttribute("aria-roledescription", "carousel");
  await expect(region).not.toHaveAttribute("data-autoplaying", /.*/);

  const cta = region.getByRole("link", { name: "MUA NGAY" });
  await expect(cta).toHaveCount(1);
  await expect(cta).toHaveAttribute("href", `/collections/${TEST_PREFIX}1`);
  await expect(page.getByText("Khám phá thiết kế", { exact: true })).toHaveCount(0);

  const box = await region.boundingBox();
  expect(box?.x).toBe(0);
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(844);

  const headerBackground = await page.locator("header.site-header").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(headerBackground).toBe("rgba(0, 0, 0, 0)");
});

test("slider advances after three seconds and pauses/resumes for hover and keyboard focus", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");
  await addHeroSlide(3, "https://content.pancake.vn/1/2/3/4/hero-three.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const region = hero(page);
  await expect(region.getByRole("button")).toHaveCount(0);
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveCount(1);
  await expect(region).toHaveAttribute("data-autoplaying", "true");
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute(
    "href",
    `/collections/${TEST_PREFIX}1`,
  );

  // Restart the autoplay interval from a known point so this timing assertion does not inherit
  // however long navigation + hydration took on the runner.
  await region.hover();
  await expect(region).toHaveAttribute("data-autoplaying", "false");
  await page.mouse.move(0, 0);
  await expect(region).toHaveAttribute("data-autoplaying", "true");

  // Observe the active-state mutation before the autoplay deadline. Waiting for the active CTA to
  // change and only then polling opacity is racy on CI: by the time Playwright resolves the role
  // locator, the 500ms CSS transition may already have completed.
  const autoplayFadeObserved = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const slides = [...document.querySelectorAll<HTMLElement>(".home-hero__slide")];
        const oldSlide = slides[0];
        const newSlide = slides[1];
        if (!oldSlide || !newSlide) {
          resolve(false);
          return;
        }

        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          resolve(value);
        };

        const observer = new MutationObserver(() => {
          if (newSlide.dataset.active !== "true") return;
          requestAnimationFrame(() => {
            window.setTimeout(() => {
              const oldOpacity = Number(getComputedStyle(oldSlide).opacity);
              const newOpacity = Number(getComputedStyle(newSlide).opacity);
              finish(
                oldOpacity > 0 &&
                  oldOpacity < 1 &&
                  newOpacity > 0 &&
                  newOpacity < 1,
              );
            }, 100);
          });
        });

        observer.observe(newSlide, { attributes: true, attributeFilter: ["data-active"] });
        window.setTimeout(() => finish(false), 4_000);
      }),
  );

  await page.waitForTimeout(2_700);
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute(
    "href",
    `/collections/${TEST_PREFIX}1`,
  );
  await expect
    .poll(async () => region.getByRole("link", { name: "MUA NGAY" }).getAttribute("href"), {
      timeout: 1_000,
    })
    .toBe(`/collections/${TEST_PREFIX}2`);
  expect(await autoplayFadeObserved).toBe(true);

  await region.hover();
  await expect(region).toHaveAttribute("data-autoplaying", "false");
  const hoverHref = await region.getByRole("link", { name: "MUA NGAY" }).getAttribute("href");
  await page.waitForTimeout(3_300);
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute("href", hoverHref!);

  await page.mouse.move(0, 0);
  await expect(region).toHaveAttribute("data-autoplaying", "true");

  const cta = region.getByRole("link", { name: "MUA NGAY" });
  await cta.focus();
  await expect(region).toHaveAttribute("data-autoplaying", "false");
  const focusHref = await cta.getAttribute("href");
  await page.waitForTimeout(3_300);
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute("href", focusHref!);

  await page.getByRole("link", { name: "La.na Design — Trang chủ" }).focus();
  await expect(region).toHaveAttribute("data-autoplaying", "true");
});

test("MUA NGAY remains pointer-clickable inside the swipe track and follows the active slide href", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const region = hero(page);
  await region.hover();
  await expect(region).toHaveAttribute("data-autoplaying", "false");

  const cta = region.getByRole("link", { name: "MUA NGAY" });
  await expect(cta).toHaveAttribute("href", `/collections/${TEST_PREFIX}1`);

  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${TEST_PREFIX}1`),
    cta.click(),
  ]);

  await expect(
    page.getByRole("heading", { level: 1, name: "F6a Hero 1" }),
  ).toBeVisible();
});

test("slider cross-fades slides for 500ms while only the active slide stays interactive", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const region = hero(page);
  await region.hover();
  await expect(region).toHaveAttribute("data-autoplaying", "false");

  const slides = region.locator(".home-hero__slide");
  const first = slides.nth(0);
  const second = slides.nth(1);
  await expect(first).toHaveAttribute("data-active", "true");
  await expect(second).toHaveAttribute("data-active", "false");
  expect(await first.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.5s");
  expect(await second.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.5s");

  const track = page.locator(".home-hero__track");
  const box = await track.boundingBox();
  if (!box) throw new Error("Expected the hero track to have a layout box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
  await page.mouse.up();

  // During the 500ms transition both image layers remain visually present. Check this first,
  // before semantic assertions consume the transition window.
  await expect
    .poll(
      async () => {
        const [oldOpacity, newOpacity] = await Promise.all([
          first.evaluate((element) => Number(getComputedStyle(element).opacity)),
          second.evaluate((element) => Number(getComputedStyle(element).opacity)),
        ]);
        return oldOpacity > 0 && oldOpacity < 1 && newOpacity > 0 && newOpacity < 1;
      },
      { timeout: 450 },
    )
    .toBe(true);

  await expect(first).toHaveAttribute("data-active", "false");
  await expect(second).toHaveAttribute("data-active", "true");
  await expect(first).toHaveAttribute("aria-hidden", "true");
  await expect(second).not.toHaveAttribute("aria-hidden", "true");
  await expect(first.locator("a")).toHaveAttribute("tabindex", "-1");
  await expect(second.locator("a")).not.toHaveAttribute("tabindex", "-1");
  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveCount(1);

  await page.waitForTimeout(550);
  expect(await first.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  expect(await second.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  expect(await first.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  expect(await second.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
});

test("swipe pauses during interaction, advances, then resumes autoplay", async ({ page }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const region = hero(page);
  const track = page.locator(".home-hero__track");
  const box = await track.boundingBox();
  if (!box) throw new Error("Expected the hero track to have a layout box");

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await expect(region).toHaveAttribute("data-autoplaying", "false");
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
  await page.mouse.up();

  await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute(
    "href",
    `/collections/${TEST_PREFIX}2`,
  );
  // The drag has ended, but the mouse is still hovering the hero, so hover remains an
  // independent pause reason. Autoplay resumes only after the pointer leaves the hero.
  await expect(region).toHaveAttribute("data-autoplaying", "false");
  await page.mouse.move(0, 0);
  await expect(region).toHaveAttribute("data-autoplaying", "true");
});

test("reduced motion disables autoplay while keeping swipe manual interaction", async ({ browser }) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");
  await addHeroSlide(2, "https://content.pancake.vn/1/2/3/4/hero-two.jpg");

  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    const region = hero(page);
    await expect(region).toHaveAttribute("data-autoplaying", "false");
    expect(
      await region
        .locator(".home-hero__slide")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    ).toBe("0s");
    const track = page.locator(".home-hero__track");
    const box = await track.boundingBox();
    if (!box) throw new Error("Expected the hero track to have a layout box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
    await page.mouse.up();
    await expect(region.getByRole("link", { name: "MUA NGAY" })).toHaveAttribute(
      "href",
      `/collections/${TEST_PREFIX}2`,
    );
    await expect(region).toHaveAttribute("data-autoplaying", "false");
  } finally {
    await context.close();
  }
});

test("overlay header is transparent at top and cream after the existing short scroll threshold", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const header = page.locator("header.site-header");
  expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );

  await page.evaluate(() => window.scrollTo(0, 30));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
  await expect(header).toHaveAttribute("data-scrolled", "true");
  expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(header).toHaveAttribute("data-scrolled", "false");
  // The header intentionally has a 300ms color transition. The state attribute flips before the
  // transition finishes, so assert the settled visual state instead of sampling mid-transition.
  await expect
    .poll(() => header.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
});


test("homepage promotion bar follows the existing scrolled header state without reserving space", async ({
  page,
}) => {
  await clearHeroSlides();
  await addHeroSlide(1, "https://content.pancake.vn/1/2/3/4/hero-one.jpg");

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const header = page.locator("header.site-header");
    const promotion = page.locator(".promotion-shell");

    await expect(header).toHaveAttribute("data-scrolled", "false");
    await expect(promotion).toBeHidden();
    expect(await promotion.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);

    await page.evaluate(() => window.scrollTo(0, 30));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
    await expect(header).toHaveAttribute("data-scrolled", "true");
    await expect(promotion).toBeVisible();
    expect(await promotion.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(header).toHaveAttribute("data-scrolled", "false");
    await expect(promotion).toBeHidden();
    expect(await promotion.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  }

  await page.goto(`${BASE_URL}/about`, { waitUntil: "networkidle" });
  await expect(page.locator(".promotion-shell")).toBeVisible();
});
