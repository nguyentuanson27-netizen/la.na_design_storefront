import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3220;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 926_006;
const suffix = `${process.pid}`;
const collectionSlug = `runtime-breadcrumb-${suffix}`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js collection breadcrumb server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/collections/${collectionSlug}`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for collection breadcrumb server\n${serverOutput}`);
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

test.beforeAll(async () => {
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
  await prisma.collectionDefinition.create({
    data: {
      slug: collectionSlug,
      title: "Runtime Breadcrumb Collection",
      description: "Published collection for U6a breadcrumb verification.",
      isPublished: true,
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/collection-breadcrumb",
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      SEARCH_INDEXING_ENABLED: "false",
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
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
  await prisma.$disconnect();
});

test("U6a collection JSON-LD mirrors the visible breadcrumb and configured storefront origin", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/collections/${collectionSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const visibleBreadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(visibleBreadcrumb.getByRole("link", { name: "Trang chủ", exact: true })).toHaveAttribute("href", "/");
  await expect(visibleBreadcrumb.getByRole("link", { name: "Bộ sưu tập", exact: true })).toHaveAttribute(
    "href",
    "/collections",
  );
  await expect(visibleBreadcrumb.getByText("Runtime Breadcrumb Collection", { exact: true })).toBeVisible();

  const jsonLdDocuments = await page.locator('script[type="application/ld+json"]').allTextContents();
  const breadcrumb = jsonLdDocuments
    .map((document) => JSON.parse(document) as Record<string, unknown>)
    .find((document) => document["@type"] === "BreadcrumbList");

  expect(breadcrumb).toEqual({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Trang chủ",
        item: `${BASE_URL}/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Bộ sưu tập",
        item: `${BASE_URL}/collections`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Runtime Breadcrumb Collection",
      },
    ],
  });

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});
