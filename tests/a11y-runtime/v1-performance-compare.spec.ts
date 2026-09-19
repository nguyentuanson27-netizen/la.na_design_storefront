import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

const CURRENT_APP_ROOT = resolve(import.meta.dirname, "../..");
const BASELINE_APP_ROOT = process.env.V1_BASELINE_APP_ROOT ?? "";
const HOST = "127.0.0.1";
const CURRENT_PORT = 3241;
const BASELINE_PORT = 3240;
const CURRENT_URL = `http://${HOST}:${CURRENT_PORT}`;
const BASELINE_URL = `http://${HOST}:${BASELINE_PORT}`;
const SHOP_ID = 920_020;
const PRODUCT_SLUG = "v1-performance-product";
const PRODUCT_NAME = "V1 Performance Product";
const SYNCED_AT = new Date("2026-09-19T00:00:00.000Z");
const SAMPLE_COUNT = 3;

const NETWORK_PROFILE = Object.freeze({
  latencyMs: 100,
  downloadBitsPerSecond: 4_000_000,
  uploadBitsPerSecond: 1_000_000,
  cpuSlowdownMultiplier: 4,
});

const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

type RuntimeLabel = "baseline" | "current";
type ViewportLabel = "mobile" | "desktop";
type RouteLabel = "home" | "plp" | "pdp";

type ResourceSample = Readonly<{
  name: string;
  initiatorType: string;
  transferSize: number;
}>;

type MetricSample = Readonly<{
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  cls: number;
  domContentLoadedMs: number;
  loadMs: number;
  resourceCount: number;
  resourceTransferBytes: number;
  topResources: readonly ResourceSample[];
}>;

let currentServer: ChildProcess | undefined;
let baselineServer: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(label: RuntimeLabel, chunk: Buffer) {
  serverOutput = `${serverOutput}\n[${label}] ${chunk.toString()}`.slice(-30_000);
}

async function waitForServer(baseUrl: string, label: RuntimeLabel) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${baseUrl}/shop/${PRODUCT_SLUG}`, { redirect: "manual" }),
        fetch(`${baseUrl}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status === 200 && authResponse.status === 200) {
        const html = await pageResponse.text();
        if (html.includes(PRODUCT_NAME)) return;
      }
    } catch {
      // Production server may still be starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} server\n${serverOutput}`);
}

async function stopServer(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  }
}

function startServer(root: string, port: number, label: RuntimeLabel) {
  const nextCli = resolve(root, "node_modules/next/dist/bin/next");
  const baseUrl = `http://${HOST}:${port}`;
  const server = spawn(process.execPath, [nextCli, "start", "--hostname", HOST, "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      APP_DOMAIN: `${HOST}:${port}`,
      BETTER_AUTH_URL: baseUrl,
      PANCAKE_SHOP_ID: String(SHOP_ID),
      SEARCH_INDEXING_ENABLED: "false",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => captureServerOutput(label, chunk));
  server.stderr?.on("data", (chunk: Buffer) => captureServerOutput(label, chunk));
  return server;
}

async function seedFixture() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: "v1-performance-product-external",
      slug: PRODUCT_SLUG,
      name: PRODUCT_NAME,
      sourceDescription: "Stable V1 performance fixture.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/v1-performance-primary.jpg",
      isPresent: true,
      isActive: true,
      syncedAt: SYNCED_AT,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Stable storefront copy for V1 performance comparison.",
          material: "Cotton",
          craftDetails: ["Performance fixture"],
          careInstructions: "Giặt nhẹ.",
          seoTitle: "V1 performance product",
          seoDescription: "Stable V1 performance fixture.",
          collectionSlugs: [],
        },
      },
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "v1-performance-variant",
      productId: product.id,
      color: "Ink",
      size: "M",
      pancakeImageUrls: [
        "https://content.pancake.vn/images/1/2/3/v1-performance-primary.jpg",
        "https://content.pancake.vn/images/1/2/3/v1-performance-back.jpg",
        "https://content.pancake.vn/images/1/2/3/v1-performance-detail.jpg",
      ],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 890_000,
      pancakeRetailPriceAfterDiscount: 890_000,
      syncedAt: SYNCED_AT,
    },
  });

  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: "v1-performance-warehouse",
      quantity: 5,
      syncedAt: SYNCED_AT,
    },
  });
}

async function createMeasuredPage(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page; browserErrors: string[]; failedResponses: string[] }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });

  await context.addInitScript(() => {
    const state = { lcpMs: 0, cls: 0 };
    (window as typeof window & { __v1Perf?: typeof state }).__v1Perf = state;

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const latest = entries.at(-1);
      if (latest) state.lcpMs = latest.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (!shift.hadRecentInput) state.cls += shift.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: NETWORK_PROFILE.latencyMs,
    downloadThroughput: NETWORK_PROFILE.downloadBitsPerSecond / 8,
    uploadThroughput: NETWORK_PROFILE.uploadBitsPerSecond / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: NETWORK_PROFILE.cpuSlowdownMultiplier,
  });

  return { context, page, browserErrors, failedResponses };
}

async function measureOnce(page: Page, url: string): Promise<MetricSample> {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await page.waitForTimeout(250);

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const perfState = (window as typeof window & { __v1Perf?: { lcpMs: number; cls: number } }).__v1Perf;

    if (!navigation || !fcp || !perfState || perfState.lcpMs <= 0) return null;

    return {
      ttfbMs: navigation.responseStart,
      fcpMs: fcp.startTime,
      lcpMs: perfState.lcpMs,
      cls: perfState.cls,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      loadMs: navigation.loadEventEnd,
      resourceCount: resources.length,
      resourceTransferBytes: resources.reduce((sum, resource) => sum + resource.transferSize, 0),
      topResources: resources
        .map((resource) => ({
          name: new URL(resource.name).pathname,
          initiatorType: resource.initiatorType,
          transferSize: resource.transferSize,
        }))
        .sort((left, right) => right.transferSize - left.transferSize)
        .slice(0, 12),
    };
  });

  expect(metrics).not.toBeNull();
  return metrics!;
}

function median(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function summarize(samples: readonly MetricSample[]) {
  return {
    ttfbMs: median(samples.map((sample) => sample.ttfbMs)),
    fcpMs: median(samples.map((sample) => sample.fcpMs)),
    lcpMs: median(samples.map((sample) => sample.lcpMs)),
    cls: median(samples.map((sample) => sample.cls)),
    domContentLoadedMs: median(samples.map((sample) => sample.domContentLoadedMs)),
    loadMs: median(samples.map((sample) => sample.loadMs)),
    resourceCount: median(samples.map((sample) => sample.resourceCount)),
    resourceTransferBytes: median(samples.map((sample) => sample.resourceTransferBytes)),
  };
}

function changePct(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return ((current - baseline) / baseline) * 100;
}

test.beforeAll(async () => {
  expect(BASELINE_APP_ROOT, "V1_BASELINE_APP_ROOT must point at the exact baseline checkout").not.toBe("");
  await seedFixture();

  baselineServer = startServer(BASELINE_APP_ROOT, BASELINE_PORT, "baseline");
  currentServer = startServer(CURRENT_APP_ROOT, CURRENT_PORT, "current");

  await Promise.all([
    waitForServer(BASELINE_URL, "baseline"),
    waitForServer(CURRENT_URL, "current"),
  ]);
});

test.afterAll(async () => {
  await Promise.all([stopServer(baselineServer), stopServer(currentServer)]);
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.$disconnect();
});

test("V1 compares Home PLP PDP against the approved baseline with identical fixture and profile", async ({ browser }) => {
  const viewports = [
    { name: "mobile" as const, width: 390, height: 844 },
    { name: "desktop" as const, width: 1440, height: 900 },
  ];
  const routes = [
    { name: "home" as const, path: "/" },
    { name: "plp" as const, path: "/shop" },
    { name: "pdp" as const, path: `/shop/${PRODUCT_SLUG}` },
  ];

  const report: Record<string, unknown> = {
    baselineSha: "8f7b20552d7dee0df4dff8e662ce508276a65f72",
    sampleCount: SAMPLE_COUNT,
    profile: NETWORK_PROFILE,
    results: {},
  };
  const results = report.results as Record<string, unknown>;

  for (const viewport of viewports) {
    for (const route of routes) {
      const key = `${viewport.name}:${route.name}`;
      const runtimeSamples: Record<RuntimeLabel, MetricSample[]> = {
        baseline: [],
        current: [],
      };

      for (const runtime of ["baseline", "current"] as const) {
        const baseUrl = runtime === "baseline" ? BASELINE_URL : CURRENT_URL;

        // One warm-up navigation per route/runtime is deliberately excluded from the measurements.
        {
          const { context, page } = await createMeasuredPage(browser, viewport);
          try {
            await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle" });
          } finally {
            await context.close();
          }
        }

        for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
          const { context, page, browserErrors, failedResponses } = await createMeasuredPage(browser, viewport);
          try {
            const metrics = await measureOnce(page, `${baseUrl}${route.path}`);
            runtimeSamples[runtime].push(metrics);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            ).toBe(true);
            expect(browserErrors).toEqual([]);
            expect(failedResponses).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }

      const baseline = summarize(runtimeSamples.baseline);
      const current = summarize(runtimeSamples.current);
      const deltaPct = {
        ttfbMs: changePct(current.ttfbMs, baseline.ttfbMs),
        fcpMs: changePct(current.fcpMs, baseline.fcpMs),
        lcpMs: changePct(current.lcpMs, baseline.lcpMs),
        cls: changePct(current.cls, baseline.cls),
        domContentLoadedMs: changePct(current.domContentLoadedMs, baseline.domContentLoadedMs),
        loadMs: changePct(current.loadMs, baseline.loadMs),
        resourceCount: changePct(current.resourceCount, baseline.resourceCount),
        resourceTransferBytes: changePct(current.resourceTransferBytes, baseline.resourceTransferBytes),
      };

      results[key] = {
        baseline,
        current,
        deltaPct,
        topResources: {
          baseline: runtimeSamples.baseline[0]?.topResources ?? [],
          current: runtimeSamples.current[0]?.topResources ?? [],
        },
      };
    }
  }

  console.log(`V1_PERFORMANCE_COMPARISON ${JSON.stringify(report)}`);
});
