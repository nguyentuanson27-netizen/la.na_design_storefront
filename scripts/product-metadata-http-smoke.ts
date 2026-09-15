import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../src/db/prisma.ts";
import { PRODUCT_SOCIAL_FALLBACK_PATH } from "../src/seo/product-metadata.ts";
import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../src/commerce/storefront-origin.ts";

const HOST = "127.0.0.1";
const PORT = 3215;
const BASE_URL = `http://${HOST}:${PORT}`;
const SHOP_ID = 920_009;
const PUBLIC_ORIGIN = `https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`;
const STAGING_ORIGIN = `https://${LEGACY_TEMPORARY_STOREFRONT_HOST}`;
const TRUSTED_IMAGE_URL = "https://content.pancake.vn/catalog/11/22/33/p13-trusted.jpg";
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const trustedProductId = `p13-http-trusted-${runId}`;
const publishedDuplicateProductId = `p13-http-published-duplicate-${runId}`;
const fallbackProductAId = `p13-http-fallback-a-${runId}`;
const fallbackProductBId = `p13-http-fallback-b-${runId}`;
const trustedSlug = `p13-trusted-${runId}`;
const publishedDuplicateSlug = `p13-published-duplicate-${runId}`;
const fallbackSlugA = `p13-fallback-a-${runId}`;
const fallbackSlugB = `p13-fallback-b-${runId}`;
const unknownSlug = `p13-unknown-${runId}`;
const duplicateName = "P13 Same Name Product";
const publishedSeoTitle = "P13 Published SEO Title";
const publishedSeoDescription = "P13 published factual SEO description.";

let server: ChildProcess | undefined;
let serverOutput = "";

type HttpResponse = Readonly<{
  status: number;
  contentType: string | null;
  body: string;
}>;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function requestPath(path: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

async function requestBinaryPath(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes,
  };
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js P13 metadata server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/lookbook`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js P13 metadata server\n${serverOutput}`);
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
  await prisma.productMirror.deleteMany({
    where: {
      pancakeProductId: {
        in: [
          trustedProductId,
          publishedDuplicateProductId,
          fallbackProductAId,
          fallbackProductBId,
        ],
      },
    },
  });
}

function assertContains(body: string, expected: string, label: string) {
  assert.ok(body.includes(expected), `${label} must include ${expected}\n${serverOutput}`);
}

function assertNotContains(body: string, unexpected: string, label: string) {
  assert.equal(body.includes(unexpected), false, `${label} must not include ${unexpected}`);
}

try {
  await cleanupDatabase();

  await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: trustedProductId,
      slug: trustedSlug,
      name: "P13 Trusted Product",
      primaryImageUrl: TRUSTED_IMAGE_URL,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
      content: {
        create: {
          status: "PUBLISHED",
          seoTitle: publishedSeoTitle,
          seoDescription: publishedSeoDescription,
        },
      },
    },
  });

  await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: publishedDuplicateProductId,
      slug: publishedDuplicateSlug,
      name: "P13 Published Duplicate Product",
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
      content: {
        create: {
          status: "PUBLISHED",
          seoTitle: publishedSeoTitle,
          seoDescription: publishedSeoDescription,
        },
      },
    },
  });

  for (const [pancakeProductId, slug] of [
    [fallbackProductAId, fallbackSlugA],
    [fallbackProductBId, fallbackSlugB],
  ] as const) {
    await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP_ID,
        pancakeProductId,
        slug,
        name: duplicateName,
        isPresent: true,
        isActive: true,
        syncedAt: new Date(),
      },
    });
  }

  await startServer({
    APP_DOMAIN: OFFICIAL_PRODUCTION_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "true",
  });

  const trustedPage = await requestPath(`/shop/${trustedSlug}`);
  assert.equal(trustedPage.status, 200, `trusted PDP must return 200\n${serverOutput}`);
  const trustedTitle = `${publishedSeoTitle} — ${trustedSlug}`;
  const trustedDescription = `${publishedSeoDescription} — /shop/${trustedSlug}.`;
  assertContains(trustedPage.body, `<title>${trustedTitle} — LA Clothing</title>`, "trusted PDP head");
  assertContains(trustedPage.body, `name="description" content="${trustedDescription}"`, "trusted PDP head");
  assertContains(trustedPage.body, `rel="canonical" href="${PUBLIC_ORIGIN}/shop/${trustedSlug}"`, "trusted PDP head");
  assertContains(trustedPage.body, `property="og:title" content="${trustedTitle}"`, "trusted PDP Open Graph");
  assertContains(trustedPage.body, `property="og:url" content="${PUBLIC_ORIGIN}/shop/${trustedSlug}"`, "trusted PDP Open Graph");
  assertContains(trustedPage.body, `property="og:image" content="${TRUSTED_IMAGE_URL}"`, "trusted PDP Open Graph");
  assertContains(trustedPage.body, `name="twitter:image" content="${TRUSTED_IMAGE_URL}"`, "trusted PDP Twitter card");
  assertNotContains(trustedPage.body, PRODUCT_SOCIAL_FALLBACK_PATH, "trusted PDP social metadata");

  const publishedDuplicatePage = await requestPath(`/shop/${publishedDuplicateSlug}`);
  assert.equal(publishedDuplicatePage.status, 200, "published duplicate PDP must return 200");
  const publishedDuplicateTitle = `${publishedSeoTitle} — ${publishedDuplicateSlug}`;
  const publishedDuplicateDescription = `${publishedSeoDescription} — /shop/${publishedDuplicateSlug}.`;
  assertContains(
    publishedDuplicatePage.body,
    `<title>${publishedDuplicateTitle} — LA Clothing</title>`,
    "published duplicate PDP head",
  );
  assertContains(
    publishedDuplicatePage.body,
    `name="description" content="${publishedDuplicateDescription}"`,
    "published duplicate PDP head",
  );
  assertContains(
    publishedDuplicatePage.body,
    `rel="canonical" href="${PUBLIC_ORIGIN}/shop/${publishedDuplicateSlug}"`,
    "published duplicate canonical",
  );
  assert.notEqual(trustedTitle, publishedDuplicateTitle, "duplicate published SEO titles must remain unique");
  assert.notEqual(
    trustedDescription,
    publishedDuplicateDescription,
    "duplicate published SEO descriptions must remain unique",
  );

  const fallbackPageA = await requestPath(`/shop/${fallbackSlugA}`);
  const fallbackPageB = await requestPath(`/shop/${fallbackSlugB}`);
  assert.equal(fallbackPageA.status, 200, "first fallback PDP must return 200");
  assert.equal(fallbackPageB.status, 200, "second fallback PDP must return 200");

  const fallbackTitleA = `${duplicateName} — ${fallbackSlugA}`;
  const fallbackTitleB = `${duplicateName} — ${fallbackSlugB}`;
  const fallbackDescriptionA = `Thông tin sản phẩm ${duplicateName} tại LA Clothing — /shop/${fallbackSlugA}.`;
  const fallbackDescriptionB = `Thông tin sản phẩm ${duplicateName} tại LA Clothing — /shop/${fallbackSlugB}.`;

  assertContains(fallbackPageA.body, `<title>${fallbackTitleA} — LA Clothing</title>`, "first fallback PDP head");
  assertContains(fallbackPageB.body, `<title>${fallbackTitleB} — LA Clothing</title>`, "second fallback PDP head");
  assertContains(fallbackPageA.body, `name="description" content="${fallbackDescriptionA}"`, "first fallback PDP head");
  assertContains(fallbackPageB.body, `name="description" content="${fallbackDescriptionB}"`, "second fallback PDP head");
  assertContains(fallbackPageA.body, `rel="canonical" href="${PUBLIC_ORIGIN}/shop/${fallbackSlugA}"`, "first fallback canonical");
  assertContains(fallbackPageB.body, `rel="canonical" href="${PUBLIC_ORIGIN}/shop/${fallbackSlugB}"`, "second fallback canonical");
  assertContains(fallbackPageA.body, `property="og:image" content="${PUBLIC_ORIGIN}${PRODUCT_SOCIAL_FALLBACK_PATH}"`, "fallback Open Graph image");
  assertContains(fallbackPageA.body, `name="twitter:image" content="${PUBLIC_ORIGIN}${PRODUCT_SOCIAL_FALLBACK_PATH}"`, "fallback Twitter image");
  assert.notEqual(fallbackTitleA, fallbackTitleB, "same-name fallback titles must remain unique");
  assert.notEqual(fallbackDescriptionA, fallbackDescriptionB, "same-name fallback descriptions must remain unique");

  const fallbackImage = await requestBinaryPath(PRODUCT_SOCIAL_FALLBACK_PATH);
  assert.equal(fallbackImage.status, 200, "website-owned fallback social image must resolve");
  assert.match(fallbackImage.contentType ?? "", /^image\/png(?:;|$)/, "fallback social image must be PNG");
  assert.ok(fallbackImage.bytes.length > 1_000, "fallback social image must contain a rendered branded card");

  // U30a / W8: the homepage declares no social metadata of its own, so what it serves is the root
  // fallback. Proving it here rather than in a second runtime harness keeps one server boot.
  const homePage = await requestPath("/");
  assert.equal(homePage.status, 200, "homepage must remain browseable");
  assertContains(homePage.body, 'property="og:site_name" content="LA Clothing"', "homepage Open Graph");
  assertContains(homePage.body, 'property="og:title" content="LA Clothing — Modern Menswear"', "homepage Open Graph");
  assertContains(
    homePage.body,
    `property="og:image" content="${PUBLIC_ORIGIN}${PRODUCT_SOCIAL_FALLBACK_PATH}"`,
    "homepage Open Graph image",
  );
  assertContains(homePage.body, 'name="twitter:card" content="summary_large_image"', "homepage Twitter card");
  assertContains(
    homePage.body,
    `name="twitter:image" content="${PUBLIC_ORIGIN}${PRODUCT_SOCIAL_FALLBACK_PATH}"`,
    "homepage Twitter image",
  );

  // The PDP still overrides the fallback with its own product card rather than inheriting it.
  assertContains(trustedPage.body, `property="og:url" content="${PUBLIC_ORIGIN}/shop/${trustedSlug}"`, "trusted PDP Open Graph URL");

  const unknownPage = await requestPath(`/shop/${unknownSlug}`);
  assert.equal(unknownPage.status, 404, "unknown product slug must remain exact 404");
  assertNotContains(unknownPage.body, 'rel="canonical"', "unknown product response");

  await restartServer({
    APP_DOMAIN: LEGACY_TEMPORARY_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "false",
  });

  const stagingPage = await requestPath(`/shop/${fallbackSlugA}`);
  assert.equal(stagingPage.status, 200, "staging PDP must remain browseable");
  assertContains(stagingPage.body, 'name="robots" content="noindex, nofollow"', "staging PDP head");
  assertNotContains(stagingPage.body, 'rel="canonical"', "staging PDP head");
  assertContains(stagingPage.body, `property="og:url" content="${STAGING_ORIGIN}/shop/${fallbackSlugA}"`, "staging PDP Open Graph");

  console.log(
    "P13/U30a metadata HTTP smoke passed: published duplicate SEO and fallback heads stay slug-unique, trusted media is direct, fallback PNG resolves, the homepage serves the branded root social fallback while the PDP keeps its own card, unknown slug is 404, and staging withholds canonical under noindex.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}
