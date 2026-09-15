import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../src/db/prisma.ts";
import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../src/commerce/storefront-origin.ts";

const HOST = "127.0.0.1";
const PORT = 3220;
const BASE_URL = `http://${HOST}:${PORT}`;
const SHOP_ID = 920_015;
const PUBLIC_ORIGIN = `https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`;
const PRODUCT_COUNT = 25;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const collectionSlug = `p15-http-collection-${runId}`;
const productIds = Array.from(
  { length: PRODUCT_COUNT },
  (_, index) => `p15-http-product-${runId}-${String(index + 1).padStart(2, "0")}`,
);
const pageTwoProductId = productIds[PRODUCT_COUNT - 1]!;
const pageTwoProductSlug = `${pageTwoProductId}-slug`;
const pageTwoProductName = `P15 HTTP Product ${String(PRODUCT_COUNT).padStart(2, "0")}`;

let server: ChildProcess | undefined;
let serverOutput = "";

type HttpResponse = Readonly<{
  status: number;
  xRobotsTag: string | null;
  body: string;
}>;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function canonicalHref(body: string): string | null {
  const linkTags = body.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/\brel=(?:"canonical"|'canonical')/i.test(tag)) continue;
    const href = tag.match(/\bhref=(?:"([^"]+)"|'([^']+)')/i);
    return href?.[1] ?? href?.[2] ?? null;
  }
  return null;
}

function hasNoIndexMeta(body: string): boolean {
  const metaTags = body.match(/<meta\b[^>]*>/gi) ?? [];
  return metaTags.some(
    (tag) =>
      /\bname=(?:"robots"|'robots')/i.test(tag) &&
      /\bcontent=(?:"[^"]*\bnoindex\b[^"]*"|'[^']*\bnoindex\b[^']*')/i.test(tag),
  );
}

function anchorHasVisibleText(body: string, href: string, text: string): boolean {
  const anchors = body.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  return anchors.some((anchor) => {
    const hrefMatch = anchor.match(/\bhref=(?:"([^"]+)"|'([^']+)')/i);
    const anchorHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? null;
    if (anchorHref !== href) return false;
    const visibleText = anchor.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return visibleText.includes(text);
  });
}

async function requestPath(path: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    xRobotsTag: response.headers.get("x-robots-tag"),
    body: await response.text(),
  };
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(
        `Next.js P15 catalog indexation server exited early with code ${server.exitCode}\n${serverOutput}`,
      );
    }

    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js P15 catalog indexation server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number): Promise<boolean> {
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

async function startServer(environment: Record<string, string>) {
  serverOutput = "";
  const spawnedServer = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...process.env,
        ...environment,
        PANCAKE_SHOP_ID: String(SHOP_ID),
        BETTER_AUTH_URL: BASE_URL,
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET ?? "p15-http-only-placeholder-secret-0123456789",
        BETTER_AUTH_IP_HEADER: process.env.BETTER_AUTH_IP_HEADER ?? "x-ci-client-ip",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = spawnedServer;
  spawnedServer.stdout?.on("data", captureServerOutput);
  spawnedServer.stderr?.on("data", captureServerOutput);
  await waitForServer();
}

async function restartServer(environment: Record<string, string>) {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  server = undefined;
  await startServer(environment);
}

async function cleanupDatabase() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
}

async function seedCatalog() {
  await prisma.collectionDefinition.create({
    data: {
      slug: collectionSlug,
      title: "P15 HTTP Collection",
      description: "Published collection used by the P15 catalog indexation HTTP smoke.",
      isPublished: true,
    },
  });

  await prisma.productMirror.createMany({
    data: productIds.map((id, index) => ({
      id,
      pancakeShopId: SHOP_ID,
      pancakeProductId: `${id}-pancake`,
      slug: `${id}-slug`,
      name: `P15 HTTP Product ${String(index + 1).padStart(2, "0")}`,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
    })),
  });

  await prisma.productContent.createMany({
    data: productIds.map((productId, index) => ({
      id: `p15-http-content-${runId}-${String(index + 1).padStart(2, "0")}`,
      productId,
      status: "DRAFT",
      collectionSlugs: [collectionSlug],
    })),
  });
}

function assertIndexableCanonical(
  response: HttpResponse,
  expectedCanonical: string,
  label: string,
) {
  assert.equal(response.status, 200, `${label} must return 200\n${serverOutput}`);
  assert.equal(response.xRobotsTag, null, `${label} must not emit X-Robots-Tag noindex`);
  assert.equal(canonicalHref(response.body), expectedCanonical, `${label} must self-canonicalize`);
  assert.equal(hasNoIndexMeta(response.body), false, `${label} must not emit robots noindex metadata`);
}

function assertNoIndexWithoutCanonical(response: HttpResponse, label: string) {
  assert.equal(response.status, 200, `${label} must remain browseable\n${serverOutput}`);
  assert.equal(
    response.xRobotsTag,
    "noindex, nofollow",
    `${label} must emit X-Robots-Tag noindex, nofollow`,
  );
  assert.equal(canonicalHref(response.body), null, `${label} must withhold canonical metadata`);
}

try {
  await cleanupDatabase();
  await seedCatalog();

  await startServer({
    APP_DOMAIN: OFFICIAL_PRODUCTION_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "true",
  });

  const shopPageOne = await requestPath("/shop");
  assertIndexableCanonical(shopPageOne, `${PUBLIC_ORIGIN}/shop`, "enabled shop page 1");
  assert.equal(
    anchorHasVisibleText(shopPageOne.body, "/shop?page=2", "Trang sau"),
    true,
    "shop page 1 must expose a visible crawlable link to page 2",
  );

  const shopPageTwo = await requestPath("/shop?page=2");
  assertIndexableCanonical(
    shopPageTwo,
    `${PUBLIC_ORIGIN}/shop?page=2`,
    "enabled shop pagination page 2",
  );
  assert.equal(
    anchorHasVisibleText(shopPageTwo.body, `/shop/${pageTwoProductSlug}`, pageTwoProductName),
    true,
    "shop page 2 must expose the product name as visible PDP anchor text",
  );

  const collectionPageOne = await requestPath(`/collections/${collectionSlug}`);
  assertIndexableCanonical(
    collectionPageOne,
    `${PUBLIC_ORIGIN}/collections/${collectionSlug}`,
    "enabled collection page 1",
  );
  assert.equal(
    anchorHasVisibleText(
      collectionPageOne.body,
      `/collections/${collectionSlug}?page=2`,
      "Trang sau",
    ),
    true,
    "collection page 1 must expose a visible crawlable link to page 2",
  );

  const collectionPageTwo = await requestPath(`/collections/${collectionSlug}?page=2`);
  assertIndexableCanonical(
    collectionPageTwo,
    `${PUBLIC_ORIGIN}/collections/${collectionSlug}?page=2`,
    "enabled collection pagination page 2",
  );
  assert.equal(
    anchorHasVisibleText(
      collectionPageTwo.body,
      `/shop/${pageTwoProductSlug}`,
      pageTwoProductName,
    ),
    true,
    "collection page 2 must expose the product name as visible PDP anchor text",
  );

  const explicitPageOne = await requestPath("/shop?page=1");
  assertNoIndexWithoutCanonical(explicitPageOne, "explicit page=1 alias");

  const mixedDiscoveryState = await requestPath("/shop?page=2&sort=name-desc");
  assertNoIndexWithoutCanonical(mixedDiscoveryState, "mixed paginated discovery state");

  await restartServer({
    APP_DOMAIN: LEGACY_TEMPORARY_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "false",
  });

  const stagingShopPageTwo = await requestPath("/shop?page=2");
  assertNoIndexWithoutCanonical(stagingShopPageTwo, "staging shop pagination page 2");
  assert.equal(
    hasNoIndexMeta(stagingShopPageTwo.body),
    true,
    "staging shop pagination must retain global robots noindex metadata",
  );

  const stagingCollectionPageTwo = await requestPath(`/collections/${collectionSlug}?page=2`);
  assertNoIndexWithoutCanonical(
    stagingCollectionPageTwo,
    "staging collection pagination page 2",
  );
  assert.equal(
    hasNoIndexMeta(stagingCollectionPageTwo.body),
    true,
    "staging collection pagination must retain global robots noindex metadata",
  );

  console.log(
    "P15 catalog indexation HTTP smoke passed: enabled catalog pages expose a visible page-1 to page-2 to PDP link chain, pure page=2 listings self-canonicalize without noindex, explicit/mixed query aliases stay noindex without canonical, and staging pagination remains noindex without canonical.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}
