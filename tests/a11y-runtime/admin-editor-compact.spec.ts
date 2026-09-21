import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3304;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-compact-${runId}@example.invalid`;
const password = "admin-compact-runtime-password-123";
const productExternalId = `admin-compact-product-${runId}`;
const productSlug = `admin-compact-product-${runId}`;
const productName = `Admin Compact Product ${runId}`;
const sourceDescription = "Read-only source must stay after website-owned controls.";

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
    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: BASE_URL,
    };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js compact-editor server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for compact-editor server\n${serverOutput}`);
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

async function cleanupDatabase() {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: productExternalId } });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  const syncedAt = new Date();
  const product = await prisma.productMirror.create({
    data: {
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: productName,
      sourceDescription,
      isPresent: true,
      isActive: false,
      syncedAt,
      variants: {
        create: [
          {
            pancakeVariationId: `compact-active-${runId}`,
            sku: "ACTIVE-M",
            size: "M",
            isPresent: true,
            isActive: true,
            syncedAt,
          },
          {
            pancakeVariationId: `compact-inactive-${runId}`,
            sku: "INACTIVE-L",
            size: "L",
            isPresent: true,
            isActive: false,
            syncedAt,
          },
        ],
      },
    },
  });
  productId = product.id;

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.31" }),
    body: {
      name: "Admin Compact Runtime",
      email: adminEmail,
      password,
    },
  });
  adminCookies = cookiesFrom(headers);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/admin-editor-compact",
      // Better Auth rejects callbacks whose origin does not match its configured base URL,
      // so it has to follow this spec's own port rather than a value pinned in the workflow.
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1"
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

test("B1/B2 keeps operational editing first and Pancake source collapsed and keyboard-accessible", async ({
  page,
  context,
}) => {
  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/products/${encodeURIComponent(productId)}`, {
    waitUntil: "networkidle",
  });

  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  const summary = page.getByRole("region", { name: "Tóm tắt vận hành sản phẩm" });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Catalog");
  await expect(summary).toContainText("Editorial");
  await expect(summary).toContainText("1 / 2 active");
  await expect(summary).toContainText("Collection");

  const orderProblems = await page.evaluate(() => {
    const entries: Array<[string, Element | null]> = [
      ["operational summary", document.querySelector("#product-operational-summary-heading")],
      ["Website commerce", document.querySelector("#website-commerce-heading")],
      ["editorial", document.querySelector("#editorial-heading")],
      ["collections", document.querySelector("#collections-heading")],
      ["SEO", document.querySelector("#seo-heading")],
      ["slug", document.querySelector("#product-slug-heading")],
      [
        "Pancake source disclosure",
        [...document.querySelectorAll("details > summary")].find((summary) =>
          summary.textContent?.includes("Nguồn Pancake"),
        ) ?? null,
      ],
    ];
    const problems = entries
      .filter(([, node]) => node === null)
      .map(([label]) => `missing: ${label}`);
    if (problems.length > 0) return problems;

    for (let index = 0; index < entries.length - 1; index += 1) {
      const [currentLabel, current] = entries[index]!;
      const [nextLabel, next] = entries[index + 1]!;
      if (!(current!.compareDocumentPosition(next!) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        problems.push(`out of order: ${currentLabel} -> ${nextLabel}`);
      }
    }
    return problems;
  });
  expect(orderProblems).toEqual([]);

  const sourceDisclosure = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Nguồn Pancake" }),
  });
  const sourceToggle = sourceDisclosure.locator("summary");
  await expect(sourceDisclosure).not.toHaveAttribute("open", "");
  await expect(sourceToggle).toBeVisible();
  await expect(page.getByText(sourceDescription, { exact: true })).toBeHidden();

  await sourceToggle.focus();
  await expect(sourceToggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sourceDisclosure).toHaveAttribute("open", "");
  await expect(page.getByText(sourceDescription, { exact: true })).toBeVisible();
  await expect(
    sourceDisclosure.getByRole("button", { name: /^(Kích hoạt|Tắt) biến thể/ }),
  ).toHaveCount(0);
});
