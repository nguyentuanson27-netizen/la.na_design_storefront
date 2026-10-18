import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3213;
const BASE_URL = `http://${HOST}:${PORT}`;
const SHOP_ID = 920_007;
const HOSTILE_HOST = "attacker.example";
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const pancakeProductId = `slug-http-product-${runId}`;
const pancakeVariationId = `slug-http-variation-${runId}`;
const pancakeWarehouseId = `slug-http-warehouse-${runId}`;
const currentSlug = `ao-so-mi-http-${runId}`;
const historicalSlug = `ao-so-mi-cu-${runId}`;
const unknownSlug = `khong-ton-tai-${runId}`;
// Route-valid (no slash, so `/shop/<slug>` still matches) but shaped like an injection attempt.
const hostileSlug = `<script>alert(${runId})</script>`;
const productName = `Áo sơ mi HTTP ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

type HttpResponse = {
  status: number;
  location: string | null;
  contentType: string | null;
  xRobotsTag: string | null;
  xContentTypeOptions: string | null;
  xFrameOptions: string | null;
  body: string;
};

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_000);
}

async function requestPath(path: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    xRobotsTag: response.headers.get("x-robots-tag"),
    xContentTypeOptions: response.headers.get("x-content-type-options"),
    xFrameOptions: response.headers.get("x-frame-options"),
    body: await response.text(),
  };
}

async function requestPathWithHost(path: string, hostHeader: string): Promise<HttpResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolveRequest({
            status: response.statusCode ?? 0,
            location: typeof response.headers.location === "string" ? response.headers.location : null,
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : null,
            xRobotsTag:
              typeof response.headers["x-robots-tag"] === "string"
                ? response.headers["x-robots-tag"]
                : null,
            xContentTypeOptions:
              typeof response.headers["x-content-type-options"] === "string"
                ? response.headers["x-content-type-options"]
                : null,
            xFrameOptions:
              typeof response.headers["x-frame-options"] === "string"
                ? response.headers["x-frame-options"]
                : null,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

/**
 * What a visitor actually reads. Scripts are stripped deliberately: the streamed RSC payload
 * embeds the request path, so two renders of the same page differ there while presenting
 * identically.
 */
function visibleText(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The 404's own recovery section, located by the heading it is labelled by. */
function sectionByAriaLabelledBy(body: string, id: string): string {
  const sections = body.match(/<section\b[^>]*>[\s\S]*?<\/section>/gi) ?? [];
  return (
    sections.find((section) => {
      const labelledBy = section.match(/\baria-labelledby=(?:"([^"]+)"|'([^']+)')/i);
      return (labelledBy?.[1] ?? labelledBy?.[2] ?? null) === id;
    }) ?? ""
  );
}

function anchorHasVisibleText(markup: string, href: string, text: string): boolean {
  const anchors = markup.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  return anchors.some((anchor) => {
    const hrefMatch = anchor.match(/\bhref=(?:"([^"]+)"|'([^']+)')/i);
    const anchorHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? null;
    if (anchorHref !== href) return false;
    return anchor.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().includes(text);
  });
}

function assertSecurityHeaders(response: HttpResponse, label: string) {
  assert.equal(response.xContentTypeOptions, "nosniff", `${label} must preserve X-Content-Type-Options`);
  assert.equal(response.xFrameOptions, "DENY", `${label} must preserve X-Frame-Options`);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js slug smoke server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js slug smoke server\n${serverOutput}`);
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

async function cleanupDatabase() {
  await prisma.productMirror.deleteMany({ where: { pancakeProductId } });
}

try {
  await cleanupDatabase();

  await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId,
      slug: currentSlug,
      name: productName,
      syncedAt: new Date(),
      slugHistory: {
        create: { slug: historicalSlug },
      },
      variants: {
        create: {
          pancakeVariationId,
          color: "Black",
          size: "M",
          pancakeRetailPrice: 500_000,
          pancakeRetailPriceAfterDiscount: 500_000,
          syncedAt: new Date(),
          warehouseStocks: {
            create: {
              pancakeWarehouseId,
              quantity: 1,
              syncedAt: new Date(),
            },
          },
        },
      },
    },
  });

  const spawnedServer = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...process.env,
        APP_DOMAIN: `${HOST}:${PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = spawnedServer;
  spawnedServer.stdout?.on("data", captureServerOutput);
  spawnedServer.stderr?.on("data", captureServerOutput);

  await waitForServer();

  const historicalResponse = await requestPathWithHost(`/shop/${historicalSlug}`, HOSTILE_HOST);
  assert.equal(
    historicalResponse.status,
    301,
    `historical slug must return exact 301, received ${historicalResponse.status}\n${serverOutput}`,
  );
  assert.equal(
    historicalResponse.location,
    `/shop/${currentSlug}`,
    "historical redirect must resolve to the exact site-owned canonical path even when the request Host is hostile",
  );
  assert.equal(
    historicalResponse.location?.includes(HOSTILE_HOST),
    false,
    "historical redirect must never contain the hostile request Host",
  );
  assertSecurityHeaders(historicalResponse, "historical slug 301");

  const currentResponse = await requestPath(`/shop/${currentSlug}`);
  assert.equal(currentResponse.status, 200, `current slug must render 200, received ${currentResponse.status}`);
  assert.ok(currentResponse.body.includes(productName), "current slug must render the current product");

  const unknownResponse = await requestPath(`/shop/${unknownSlug}`);
  assert.equal(unknownResponse.status, 404, `unknown slug must return 404, received ${unknownResponse.status}`);
  assertSecurityHeaders(unknownResponse, "unknown slug 404");

  // U30d / W14b. The status was already right; the response was a bare `text/plain` string with
  // nothing to recover from. It must answer as a page of this site instead - without becoming a
  // soft 200, a redirect, or a place to echo whatever the visitor typed.
  assert.equal(unknownResponse.location, null, "unknown slug must not redirect the visitor away");
  assert.match(
    unknownResponse.contentType ?? "",
    /^text\/html/,
    `unknown slug must answer in HTML, received ${unknownResponse.contentType}`,
  );
  assert.notEqual(
    unknownResponse.body.trim(),
    "Not Found",
    "unknown slug must not answer with a bare plain-text string",
  );

  // The response must be *the app's own 404 page*, not a second one maintained in the proxy.
  // Asserting that by looking for a link somewhere in the document would prove nothing: the site
  // header already links to /shop, /collections and /search, so the chrome would answer for the
  // 404 body and the assertion would pass with no 404 page at all. Compare the rendered text
  // against an unmatched route's 404 instead - the two must be the same page.
  //
  // It also carries the branding claim without depending on which not-found page is in the tree:
  // whatever an unmatched route renders, an unknown slug renders identically.
  const unmatchedRouteResponse = await requestPath(`/khong-co-route-nao-${runId}`);
  assert.equal(unmatchedRouteResponse.status, 404, "the unmatched-route baseline must itself be a 404");
  assert.equal(
    visibleText(unknownResponse.body),
    visibleText(unmatchedRouteResponse.body),
    "unknown slug must render the same 404 page as any unmatched route, not a synthetic proxy string",
  );

  // W14 integrated: with W14a's page on the base, the page both routes render is the branded
  // recovery surface. Every assertion below is scoped INSIDE that section - the site header links
  // to /shop, /collections and /search too, so a document-wide search would be answered by the
  // chrome and would keep passing with no recovery UI on the 404 at all.
  const recoverySection = sectionByAriaLabelledBy(unknownResponse.body, "not-found-title");
  assert.notEqual(
    recoverySection,
    "",
    "unknown slug 404 must render W14a's branded recovery section",
  );

  const recoveryText = visibleText(recoverySection);
  for (const copy of ["Không tìm thấy trang", "Trang nàng tìm không tồn tại."]) {
    assert.equal(
      recoveryText.includes(copy),
      true,
      `unknown slug 404 must state what happened, in the recovery section: ${copy}`,
    );
  }

  for (const [href, label] of [
    ["/", "Trang chủ"],
    ["/shop", "Cửa hàng"],
    ["/collections", "Bộ sưu tập"],
    ["/search", "Tìm kiếm"],
  ] as const) {
    assert.equal(
      anchorHasVisibleText(recoverySection, href, label),
      true,
      `unknown slug 404 must offer a way back to ${href} from inside the recovery section`,
    );
  }

  // The PDP route must never run for a slug that resolves to nothing: it would cost a second
  // product lookup on a path any visitor can invent, and it would put that slug in the payload.
  assert.equal(
    unknownResponse.body.includes(unknownSlug),
    false,
    "unknown slug 404 must not reflect the requested slug back into the response",
  );
  assert.equal(
    unknownResponse.body.includes(productName),
    false,
    "unknown slug 404 must not disclose catalog contents",
  );
  assert.equal(
    unknownResponse.xRobotsTag,
    "noindex, nofollow",
    "unknown slug 404 must keep the search exposure header the proxy already applied",
  );

  // The rewrite target is built on the request's own origin, so a forged Host must not be able
  // to steer it anywhere - the same property the historical 301 above is guarded for.
  const forgedHostResponse = await requestPathWithHost(`/shop/${unknownSlug}`, HOSTILE_HOST);
  assert.equal(
    forgedHostResponse.status,
    404,
    `unknown slug under a forged Host must still be 404, received ${forgedHostResponse.status}`,
  );
  assert.equal(forgedHostResponse.location, null, "a forged Host must not turn the 404 into a redirect");
  assert.equal(
    forgedHostResponse.body.includes(HOSTILE_HOST),
    false,
    "the forged request Host must never reach the 404 body",
  );

  const hostileResponse = await requestPath(`/shop/${encodeURIComponent(hostileSlug)}`);
  assert.equal(
    hostileResponse.status,
    404,
    `a route-valid hostile slug must be a deterministic 404, received ${hostileResponse.status}`,
  );
  assert.equal(hostileResponse.location, null, "a hostile slug must not redirect");
  assert.equal(
    hostileResponse.body.includes("<script>alert("),
    false,
    "a hostile slug must never be reflected unescaped into the response",
  );
  assertSecurityHeaders(hostileResponse, "hostile slug 404");

  console.log(
    "Product slug HTTP smoke passed: hostile Host cannot influence the historical 301 canonical path, current slug is 200, and unknown and hostile slugs render the app's own branded 404 recovery page - the same one an unmatched route renders - without redirecting, reflecting the slug or disclosing the catalog, while direct responses retain security headers.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}
