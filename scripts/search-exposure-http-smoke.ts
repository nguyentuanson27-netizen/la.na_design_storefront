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
const PORT = 3214;
const BASE_URL = `http://${HOST}:${PORT}`;
const SHOP_ID = 920_008;
const PUBLIC_ORIGIN = `https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const visibleProductId = `p12-http-visible-${runId}`;
const inactiveProductId = `p12-http-inactive-${runId}`;
const currentSlug = `p12-http-current-${runId}`;
const historicalSlug = `p12-http-old-${runId}`;
const inactiveSlug = `p12-http-inactive-${runId}`;
const publishedCollectionSlug = `p12-http-public-${runId}`;
const draftCollectionSlug = `p12-http-draft-${runId}`;

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

async function requestPath(path: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    xRobotsTag: response.headers.get("x-robots-tag"),
    body: await response.text(),
  };
}

async function requestPathWithHost(path: string, hostHeader: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    headers: { Host: hostHeader },
  });
  return {
    status: response.status,
    xRobotsTag: response.headers.get("x-robots-tag"),
    body: await response.text(),
  };
}

/**
 * The three exact paths asserted by the temporary-host browseability phase below - the one
 * assertion group that has shown a startup-timing symptom in CI.
 *
 * This is deliberately NOT every route the smoke asserts on: `/collections`, collection detail,
 * `/cart`, robots/sitemap and the query/pagination states are asserted elsewhere and are not
 * warmed here. Waiting on all three of these rather than `/lookbook` alone means readiness covers
 * the paths that group requests, and nothing wider - `waitForServer` is not a guarantee that every
 * asserted route has been compiled.
 *
 * This is defensive stabilization, not a verified root-cause fix. The CI failure it responds to was
 * a 500 on `/` in this group immediately after a restart. The obvious mechanism - the old readiness
 * rule returning while `/` was still mid-compile - was measured directly and did NOT reproduce: in
 * six cold-start trials (`.next/dev` removed, this phase's env) `/lookbook` passed the old <500 bar
 * after ~0.1-12s and `/` answered 200 at that same instant every time. So the exact cause of the CI
 * 500 remains unreproduced; widening readiness removes a way this group could observe a route it
 * never waited for, and is not evidence about what actually failed that run.
 */
const TEMPORARY_HOST_BROWSEABILITY_PATHS = ["/lookbook", "/shop", "/"] as const;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js search exposure server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const responses = await Promise.all(
        TEMPORARY_HOST_BROWSEABILITY_PATHS.map(
          (path) => fetch(`${BASE_URL}${path}`, { redirect: "manual" }),
        ),
      );
      if (responses.every((response) => response.status < 500)) return;
    } catch {
      // The development server may still be starting or compiling a route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js search exposure server\n${serverOutput}`);
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
    where: { pancakeProductId: { in: [visibleProductId, inactiveProductId] } },
  });
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { in: [publishedCollectionSlug, draftCollectionSlug] } },
  });
}

function assertNoIndexHeader(response: HttpResponse, label: string) {
  assert.equal(response.xRobotsTag, "noindex, nofollow", `${label} must emit X-Robots-Tag noindex, nofollow`);
}

function assertRobotsRule(body: string, rule: string, expected: boolean, label: string) {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  assert.equal(lines.includes(rule), expected, `${label}: expected ${rule} presence to be ${expected}`);
}

try {
  await cleanupDatabase();

  await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: visibleProductId,
      slug: currentSlug,
      name: "P12 HTTP visible product",
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
      slugHistory: { create: { slug: historicalSlug } },
    },
  });
  await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: inactiveProductId,
      slug: inactiveSlug,
      name: "P12 HTTP inactive product",
      isPresent: true,
      isActive: false,
      syncedAt: new Date(),
    },
  });
  await prisma.collectionDefinition.createMany({
    data: [
      {
        slug: publishedCollectionSlug,
        title: "P12 HTTP Published Collection",
        description: "Published P12 HTTP smoke collection.",
        isPublished: true,
      },
      {
        slug: draftCollectionSlug,
        title: "P12 HTTP Draft Collection",
        description: "Draft P12 HTTP smoke collection.",
        isPublished: false,
      },
    ],
  });

  await startServer({
    APP_DOMAIN: LEGACY_TEMPORARY_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "false",
  });

  const disabledRobots = await requestPath("/robots.txt");
  assert.equal(disabledRobots.status, 200, `disabled robots.txt must return 200\n${serverOutput}`);
  assertRobotsRule(disabledRobots.body, "Allow: /", true, "disabled robots.txt must keep HTML crawlable for noindex");
  assertRobotsRule(disabledRobots.body, "Disallow: /", false, "disabled robots.txt must not hide global noindex");
  assertRobotsRule(disabledRobots.body, "Disallow: /api", true, "disabled robots.txt may crawl-block API surfaces");
  assert.equal(disabledRobots.body.includes("Sitemap:"), false, "disabled robots.txt must not advertise a sitemap");

  const disabledSitemap = await requestPath("/sitemap.xml");
  assert.equal(disabledSitemap.status, 200, "disabled sitemap.xml must return 200");
  assert.equal(disabledSitemap.body.includes("<loc>"), false, "disabled sitemap must expose no canonical URLs");

  const disabledPage = await requestPath("/lookbook");
  assert.equal(disabledPage.status, 200, "disabled public page must remain browseable");
  assertNoIndexHeader(disabledPage, "disabled public page");
  // U30b / W10: a canonical nominates a URL to index, so the static pages withhold it under
  // noindex exactly as the rest of the storefront already does.
  for (const [path, page] of [
    ["/", await requestPath("/")],
    ["/collections", await requestPath("/collections")],
    ["/lookbook", disabledPage],
    ["/size-guide", await requestPath("/size-guide")],
  ] as const) {
    assertNoIndexHeader(page, `disabled ${path}`);
    assert.equal(
      page.body.includes('rel="canonical"'),
      false,
      `disabled ${path} must expose no canonical`,
    );
  }
  assert.ok(
    disabledPage.body.includes('name="robots"') && disabledPage.body.includes("noindex"),
    "disabled HTML metadata must include robots noindex",
  );

  await restartServer({
    APP_DOMAIN: OFFICIAL_PRODUCTION_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "true",
  });

  const enabledRobots = await requestPath("/robots.txt");
  assert.equal(enabledRobots.status, 200, "enabled robots.txt must return 200");
  assertRobotsRule(enabledRobots.body, "Allow: /", true, "enabled robots.txt must allow the public site");
  assertRobotsRule(enabledRobots.body, "Disallow: /api", true, "enabled robots.txt may crawl-block API surfaces");
  for (const htmlPath of ["/admin", "/account", "/cart", "/checkout", "/search", "/track-order"]) {
    assertRobotsRule(
      enabledRobots.body,
      `Disallow: ${htmlPath}`,
      false,
      `enabled robots.txt must keep ${htmlPath} crawlable so noindex is observable`,
    );
  }
  assert.ok(
    enabledRobots.body.includes(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`),
    "enabled robots.txt must advertise the canonical sitemap origin",
  );

  const enabledSitemap = await requestPath("/sitemap.xml");
  assert.equal(enabledSitemap.status, 200, "enabled sitemap.xml must return 200");
  for (const canonicalUrl of [
    `${PUBLIC_ORIGIN}/`,
    `${PUBLIC_ORIGIN}/shop`,
    `${PUBLIC_ORIGIN}/collections`,
    `${PUBLIC_ORIGIN}/lookbook`,
    `${PUBLIC_ORIGIN}/shop/${currentSlug}`,
    `${PUBLIC_ORIGIN}/collections/${publishedCollectionSlug}`,
  ]) {
    assert.ok(enabledSitemap.body.includes(canonicalUrl), `enabled sitemap must include ${canonicalUrl}`);
  }
  for (const excludedValue of [historicalSlug, inactiveSlug, draftCollectionSlug, "/admin", "/search?"]) {
    assert.equal(enabledSitemap.body.includes(excludedValue), false, `enabled sitemap must exclude ${excludedValue}`);
  }

  const indexablePage = await requestPath("/lookbook");
  assert.equal(indexablePage.status, 200, "enabled indexable page must remain 200");
  assert.equal(indexablePage.xRobotsTag, null, "enabled canonical public page must not emit X-Robots-Tag noindex");
  assert.equal(
    indexablePage.body.includes('name="robots"') && indexablePage.body.includes("noindex"),
    false,
    "enabled HTML metadata must not emit global robots noindex",
  );

  // U30b / W10, extended by U33a/b/c: each static indexable page names itself, on the server-owned
  // origin. The evergreen pages join the list because they joined the canonical set — a path that
  // is self-canonical in the builder but never checked over HTTP is a contract nothing enforces.
  for (const path of ["/", "/collections", "/lookbook", "/about", "/contact", "/returns", "/shipping", "/size-guide"] as const) {
    const page = await requestPath(path);
    assert.equal(page.status, 200, `enabled ${path} must remain 200`);
    assert.equal(
      page.xRobotsTag,
      null,
      `enabled ${path} must not emit X-Robots-Tag noindex`,
    );
    assert.equal(
      page.body.includes('name="robots"') && page.body.includes("noindex"),
      false,
      `enabled ${path} HTML metadata must not emit global robots noindex`,
    );
    // Next serialises the root canonical as the bare origin; every other path keeps its pathname.
    const expected = path === "/" ? PUBLIC_ORIGIN : `${PUBLIC_ORIGIN}${path}`;
    assert.ok(
      page.body.includes(`rel="canonical" href="${expected}"`),
      `enabled ${path} must be its own canonical on the server-owned origin`,
    );
  }

  // The canonical follows server configuration, never the request. A forged Host must not appear
  // in it and must not displace the origin the server owns.
  const forgedHostPage = await requestPathWithHost("/collections", "attacker.example.net");
  assert.ok(
    forgedHostPage.body.includes(`rel="canonical" href="${PUBLIC_ORIGIN}/collections"`),
    "a forged request Host must not change the canonical authority",
  );
  assert.equal(
    forgedHostPage.body.includes("attacker.example.net"),
    false,
    "a forged request Host must never be reflected into the page",
  );

  const queryPage = await requestPath("/lookbook?utm_source=smoke");
  assert.equal(queryPage.status, 200, "query-state public page must remain browseable");
  assertNoIndexHeader(queryPage, "query-state public page");
  assert.equal(
    queryPage.body.includes('rel="canonical"'),
    false,
    "a query-state static page is noindex, so it must not also nominate a canonical",
  );

  const sizeGuideQueryPage = await requestPath("/size-guide?utm_source=smoke");
  assert.equal(sizeGuideQueryPage.status, 200, "query-state size guide page must remain browseable");
  assertNoIndexHeader(sizeGuideQueryPage, "query-state size guide page");
  assert.equal(
    sizeGuideQueryPage.body.includes('rel="canonical"'),
    false,
    "a query-state size guide page is noindex, so it must not also nominate a canonical",
  );

  const utilityPage = await requestPath("/new-arrivals");
  assert.equal(utilityPage.status, 200, "non-launch editorial utility page must remain browseable");
  assertNoIndexHeader(utilityPage, "non-launch editorial utility page");

  const cartPage = await requestPath("/cart");
  assert.equal(cartPage.status, 200, "cart must remain browseable while excluded from indexing");
  assertNoIndexHeader(cartPage, "cart page");

  // W15b signal 2 — the temporary production host with indexing *requested*.
  //
  // The enabled phase above runs on the official production host, so it proves the permanent-domain path and
  // nothing about the legacy host production may serve during rollback. This phase is the one that
  // matters for a misconfiguration: a deployment sets `SEARCH_INDEXING_ENABLED=true` on
  // the legacy temporary host, and the response must still be noindex with no sitemap advertised. Asserting
  // it over HTTP rather than in the domain suite is the point — it proves the refusal survives the
  // whole request path, metadata rendering included, not just the policy function.
  await restartServer({
    APP_DOMAIN: LEGACY_TEMPORARY_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "true",
  });

  const temporaryHostRobots = await requestPath("/robots.txt");
  assert.equal(temporaryHostRobots.status, 200, "temporary-host robots.txt must return 200");
  assertRobotsRule(
    temporaryHostRobots.body,
    "Allow: /",
    true,
    "temporary host must stay crawlable so its noindex is observable",
  );
  assert.equal(
    temporaryHostRobots.body.includes("Sitemap:"),
    false,
    "temporary host must not advertise a sitemap even when a deployment requests indexing",
  );

  const temporaryHostSitemap = await requestPath("/sitemap.xml");
  assert.equal(temporaryHostSitemap.status, 200, "temporary-host sitemap.xml must return 200");
  assert.equal(
    temporaryHostSitemap.body.includes("<loc>"),
    false,
    "temporary host must expose no canonical URLs even when a deployment requests indexing",
  );

  for (const indexablePathOnPermanentDomain of TEMPORARY_HOST_BROWSEABILITY_PATHS) {
    const requestedIndexingPage = await requestPath(indexablePathOnPermanentDomain);
    assert.equal(
      requestedIndexingPage.status,
      200,
      `temporary-host ${indexablePathOnPermanentDomain} must remain browseable`,
    );
    assertNoIndexHeader(requestedIndexingPage, `temporary host ${indexablePathOnPermanentDomain}`);
    assert.ok(
      requestedIndexingPage.body.includes('name="robots"')
        && requestedIndexingPage.body.includes("noindex"),
      `temporary-host ${indexablePathOnPermanentDomain} HTML must keep robots noindex despite the requested indexing`,
    );
  }

  await restartServer({
    APP_DOMAIN: LEGACY_TEMPORARY_STOREFRONT_HOST,
    SEARCH_INDEXING_ENABLED: "false",
  });

  const rollbackRobots = await requestPath("/robots.txt");
  assertRobotsRule(rollbackRobots.body, "Allow: /", true, "rollback robots.txt must keep HTML crawlable for noindex");
  assertRobotsRule(rollbackRobots.body, "Disallow: /", false, "rollback must not strand prior indexable URLs behind robots.txt");
  assertRobotsRule(rollbackRobots.body, "Disallow: /api", true, "rollback may continue crawl-blocking API surfaces");
  assert.equal(rollbackRobots.body.includes("Sitemap:"), false, "rollback robots.txt must stop advertising the sitemap");

  const rollbackPage = await requestPath("/lookbook");
  assert.equal(rollbackPage.status, 200, "rollback public page must remain crawlable");
  assertNoIndexHeader(rollbackPage, "rollback public page");
  assert.ok(
    rollbackPage.body.includes('name="robots"') && rollbackPage.body.includes("noindex"),
    "rollback HTML metadata must restore robots noindex",
  );

  console.log(
    "Search exposure/U30b HTTP smoke passed: staging/rollback remain crawlable-noindex, enabled robots/sitemap use server-owned canonical origin, the three static indexable pages self-canonicalise on that origin while a forged Host and any query state withhold it, the temporary production host stays noindex even when a deployment requests indexing, API stays crawl-blocked, and HTML utility/query surfaces remain noindex.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}