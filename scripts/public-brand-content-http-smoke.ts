import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOST = "127.0.0.1";
const PORT = 3221;
const BASE_URL = `http://${HOST}:${PORT}`;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function visibleText(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function anchorHasVisibleText(body: string, href: string, text: string): boolean {
  const anchors = body.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  return anchors.some((anchor) => {
    const hrefMatch = anchor.match(/\bhref=(?:"([^"]+)"|'([^']+)')/i);
    const anchorHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? null;
    if (anchorHref !== href) return false;
    const anchorText = anchor.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return anchorText.includes(text);
  });
}

function sectionByAriaLabelledBy(body: string, id: string): string {
  const sections = body.match(/<section\b[^>]*>[\s\S]*?<\/section>/gi) ?? [];
  return (
    sections.find((section) => {
      const labelledBy = section.match(/\baria-labelledby=(?:"([^"]+)"|'([^']+)')/i);
      return (labelledBy?.[1] ?? labelledBy?.[2] ?? null) === id;
    }) ?? ""
  );
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js P16A public-brand server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js P16A public-brand server\n${serverOutput}`);
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

try {
  serverOutput = "";
  const environment = { ...process.env };
  delete environment.PANCAKE_SHOP_ID;
  server = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...environment,
        APP_DOMAIN: "shop.example.com",
        SEARCH_INDEXING_ENABLED: "true",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();

  const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
  const body = await response.text();
  assert.equal(response.status, 200, `P16A homepage must return 200\n${serverOutput}`);
  // The homepage names the brand through its approved title, in initial HTML.
  assert.equal(visibleText(body).includes("La.na Design"), true, "homepage must name the brand");
  // The homepage editorial refresh (docs/specs/homepage-editorial-refresh.md §7.7) retired the
  // homepage brand story and its facts block. The facts themselves stay published -- below, on the
  // shipping and payment policy page that owns them -- but the retired section must not return.
  assert.equal(
    sectionByAriaLabelledBy(body, "brand-facts-title"),
    "",
    "the retired homepage brand-facts section must stay absent",
  );

  const shipping = await fetch(`${BASE_URL}/shipping`, { redirect: "manual" });
  const shippingBody = await shipping.text();
  assert.equal(shipping.status, 200, `P16A shipping page must return 200\n${serverOutput}`);

  const text = visibleText(shippingBody);
  for (const fact of [
    "Thanh toán khi nhận hàng (COD).",
    "Không cần tài khoản để thanh toán.",
    "Miễn phí vận chuyển",
    "Đơn trên 1.000.000 ₫ hoặc từ 3 sản phẩm.",
    "Giá, tồn kho và phí vận chuyển được máy chủ kiểm tra lại khi bạn đặt hàng.",
  ]) {
    assert.equal(text.includes(fact), true, `shipping page must expose factual visible text: ${fact}`);
  }

  // U30c / W14a: an unmatched route must recover the visitor, not dead-end them. Next already
  // answers 404 for these; what it answers with is an unbranded default page with no way back.
  const notFound = await fetch(`${BASE_URL}/this-route-does-not-exist`, { redirect: "manual" });
  const notFoundBody = await notFound.text();

  assert.equal(notFound.status, 404, `unknown route must be an exact 404\n${serverOutput}`);
  assert.match(
    notFound.headers.get("content-type") ?? "",
    /^text\/html/,
    "unknown route must answer in HTML, not plain text",
  );
  assert.equal(notFound.headers.get("location"), null, "a 404 must not redirect the visitor away");

  // Scope every content assertion to the 404 section itself. The site header already links to
  // /shop, /collections and /search, so a document-wide search would be satisfied by the chrome
  // and would keep passing with no recovery UI on the page at all.
  const notFoundSection = sectionByAriaLabelledBy(notFoundBody, "not-found-title");
  assert.notEqual(notFoundSection, "", "unknown route must render the branded 404 section");

  const notFoundText = visibleText(notFoundSection);
  for (const copy of ["Không tìm thấy trang", "Trang bạn tìm không tồn tại."]) {
    assert.equal(notFoundText.includes(copy), true, `branded 404 must state what happened: ${copy}`);
  }

  // Recovery uses routes that exist, with the labels the rest of the site already uses.
  for (const [href, label] of [
    ["/", "Trang chủ"],
    ["/shop", "Cửa hàng"],
    ["/collections", "Bộ sưu tập"],
    ["/search", "Tìm kiếm"],
  ] as const) {
    assert.equal(
      anchorHasVisibleText(notFoundSection, href, label),
      true,
      `branded 404 must offer a way back to ${href}`,
    );
  }

  assert.equal(
    notFoundBody.includes('rel="canonical"'),
    false,
    "a 404 must not nominate itself as a canonical URL",
  );

  // A known route is unaffected by any of the above.
  const knownRoute = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
  assert.equal(knownRoute.status, 200, "an existing route must stay 200 alongside the branded 404");

  console.log("P16A/U30c public-brand HTTP smoke passed: the homepage names the brand without the retired brand-facts section, factual COD/shipping/server-verification content renders in initial HTML on the shipping page, and an unmatched route returns a branded, recoverable HTML 404 that neither redirects nor canonicalises itself.");
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
}
