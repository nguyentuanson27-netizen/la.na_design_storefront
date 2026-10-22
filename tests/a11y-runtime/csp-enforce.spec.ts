import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";

/**
 * The per-request script nonce policy (src/security/script-nonce-policy.ts) under
 * LA_CSP_STRICT_SCRIPTS=enforce. The rest of CI runs the default report-only mode, where nothing is
 * blocked, so this is the spec that proves enforcing it leaves every surface working: storefront,
 * sign-in, the 404 rewrite for an unknown product slug, and admin, with the inline analytics
 * snippets configured so their nonces are exercised too.
 *
 * Third-party origins are answered locally with an empty script: their loaders are still requested
 * and checked against the policy, but nothing leaves the runner.
 */

const HOST = "127.0.0.1";
const PORT = 3346;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `csp-enforce-${runId}@example.invalid`;
const productExternalId = `csp-enforce-${runId}`;

const STOREFRONT_PATHS = [
  "/",
  "/shop",
  "/cart",
  "/checkout",
  "/track-order",
  "/account",
  "/login",
  "/policies",
  "/khong-ton-tai",
  // A product slug nothing resolves: the proxy rewrites it to the not-found route. Constant, because
  // the path is part of a test title and Playwright matches titles across processes.
  "/shop/csp-enforce-san-pham-khong-ton-tai",
] as const;

let server: ChildProcess | undefined;
let serverOutput = "";
let productId = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Better Auth returned a malformed Set-Cookie header");
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: BASE_URL };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js CSP enforce server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for CSP enforce server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
}

async function cleanupDatabase() {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: productExternalId } });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  const product = await prisma.productMirror.create({
    data: {
      pancakeProductId: productExternalId,
      slug: productExternalId,
      name: `CSP Enforce Product ${runId}`,
      syncedAt: new Date(),
    },
  });
  productId = product.id;

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.46" }),
    body: { name: "CSP Enforce Admin", email: adminEmail, password: "csp-enforce-runtime-password-123" },
  });
  adminCookies = cookiesFrom(headers);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // One dev server per build directory; see admin-bulk-status.spec.ts.
      NEXT_DIST_DIR: ".next-test/csp-enforce",
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
      LA_CSP_STRICT_SCRIPTS: "enforce",
      // Every inline snippet the site chrome renders, so each one's nonce is exercised.
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-TESTONLY",
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: "123456789012345",
      NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "csp_enforce_pixel",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
  await cleanupDatabase();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stub */" }),
  );
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__cspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.disposition} ${event.effectiveDirective} ${event.blockedURI || "inline"}`);
    });
  });
});

/** Loads `path`, waits for React to hydrate the document, and returns what the policy blocked. */
async function loadUnderEnforcedPolicy(page: Page, path: string): Promise<string[]> {
  const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
  expect(response, path).not.toBeNull();

  const policies = (await response!.headersArray())
    .filter(({ name }) => name.toLowerCase() === "content-security-policy")
    .flatMap(({ value }) => value.split(/,\s*(?=default-src)/));
  expect(policies.length, `${path} enforces the stricter policy beside the baseline`).toBe(2);
  expect(policies[0], `${path} sends the nonce policy first`).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
  expect(policies[1], `${path} keeps the baseline`).toMatch(/script-src 'self' 'unsafe-inline'/);

  // React attaches its fiber to the nodes it hydrates; blocked chunks would leave none.
  await page.waitForFunction(() => Object.keys(document.body).some((key) => key.startsWith("__reactFiber")), null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

for (const path of STOREFRONT_PATHS) {
  test(`storefront ${path} hydrates and runs its snippets with no CSP violation under enforce`, async ({ page }) => {
    const violations = await loadUnderEnforcedPolicy(page, path);
    expect(violations, `${path} CSP violations\n${serverOutput.slice(-2_000)}`).toEqual([]);

    const snippets = await page.evaluate(() => ({
      dataLayer: Array.isArray((window as unknown as { dataLayer?: unknown }).dataLayer),
      fbq: typeof (window as unknown as { fbq?: unknown }).fbq,
      oaiq: typeof (window as unknown as { oaiq?: unknown }).oaiq,
    }));
    expect(snippets).toEqual({ dataLayer: true, fbq: "function", oaiq: "function" });
  });
}

test("admin surfaces hydrate with no CSP violation under enforce", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  for (const path of [
    "/admin",
    `/admin/products/${productId}`,
    "/admin/collections",
    "/admin/new-arrivals",
    "/admin/promotions",
    "/admin/promotions/shipping",
    "/admin/promotions/gift-quantity",
    "/admin/size-guides",
  ]) {
    const violations = await loadUnderEnforcedPolicy(page, path);
    expect(page.url(), `${path} must render for the admin, not redirect`).toBe(`${BASE_URL}${path}`);
    expect(violations, `${path} CSP violations`).toEqual([]);
  }
});

test.describe("desktop", () => {
  // The mobile layout keeps every internal link but home inside the collapsed menu and footer.
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a client-side navigation keeps working under enforce", async ({ page }) => {
    expect(await loadUnderEnforcedPolicy(page, "/")).toEqual([]);
    // Whichever internal link the homepage shows first; the router fetches the next page and runs
    // its chunks under the same document's policy.
    const link = page.locator('a[href^="/"]:not([href="/"]):not([href^="//"]):visible').first();
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
    await link.click();
    await page.waitForURL((url) => `${url.pathname}${url.search}` === href);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
  });
});

test("the report endpoint accepts a browser report and answers an empty 204", async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/csp-report`, {
    headers: { "content-type": "application/csp-report", "x-ci-client-ip": "203.0.113.46" },
    data: JSON.stringify({
      "csp-report": {
        "document-uri": `${BASE_URL}/checkout?phone=0901234567`,
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
        disposition: "enforce",
      },
    }),
  });
  expect(response.status()).toBe(204);
  expect(await response.text()).toBe("");
});
