import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3320;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TEST_PREFIX = "u2-homepage-";

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

/**
 * The homepage editorial refresh retired the collection navigation rail, the service strip and the
 * brand story (docs/specs/homepage-editorial-refresh.md §3, §7.7). Their data stays -- collections
 * keep their `homepagePosition`, which still orders the hero -- but none of it may reappear as one
 * of the old lower-homepage sections.
 */
async function expectRetiredSectionsAbsent(page: import("@playwright/test").Page) {
  await expect(page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" })).toHaveCount(0);
  await expect(page.getByText("Mua theo bộ sưu tập", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Hỗ trợ và khám phá" })).toHaveCount(0);
  for (const region of ["collection-navigation", "service", "trust-support", "new-arrivals", "featured"]) {
    await expect(page.locator(`[data-homepage-region="${region}"]`)).toHaveCount(0);
  }
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
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

test("positioned collections no longer publish the retired homepage collection rail or brand story", async ({
  page,
}) => {
  await addCollection(`${TEST_PREFIX}unpositioned`, "U2 Published Unpositioned", true);
  await addCollection(`${TEST_PREFIX}draft`, "U2 Draft Positioned", false, 1);
  await addCollection(`${TEST_PREFIX}position-two`, "U2 Position Two", true, 2);
  await addCollection(`${TEST_PREFIX}position-six`, "U2 Position Six", true, 6);

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  // No collection here publishes hero media, so the unchanged hero stays absent (master spec §17).
  // With the collection-backed refresh content still pending and no Pancake shop configured, the
  // only refreshed section is the feedback rail, whose content ships in the repository config (#74).
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);
  await expectRetiredSectionsAbsent(page);
  for (const title of [
    "U2 Published Unpositioned",
    "U2 Draft Positioned",
    "U2 Position Two",
    "U2 Position Six",
  ]) {
    await expect(page.locator("main").getByText(title, { exact: true })).toHaveCount(0);
  }
  expect(
    await page.locator("[data-homepage-region]").evaluateAll((regions) =>
      regions.map((region) => region.getAttribute("data-homepage-region")),
    ),
  ).toEqual(["feedback"]);
});
