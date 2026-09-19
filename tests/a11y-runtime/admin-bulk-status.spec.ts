import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags.ts";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

const HOST = "127.0.0.1";
const PORT = 3214;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-bulk-${runId}@example.invalid`;
const password = "admin-bulk-runtime-password-123";
const firstExternalId = `admin-bulk-first-${runId}`;
const secondExternalId = `admin-bulk-second-${runId}`;
const firstName = `Bulk Product A ${runId}`;
const secondName = `Bulk Product B ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let firstProductId = "";
let secondProductId = "";
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
      throw new Error(`Next.js admin bulk server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for admin bulk server\n${serverOutput}`);
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
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { in: [firstExternalId, secondExternalId] } },
  });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  const syncedAt = new Date();
  const first = await prisma.productMirror.create({
    data: {
      pancakeProductId: firstExternalId,
      slug: firstExternalId,
      name: firstName,
      syncedAt,
      content: {
        create: {
          status: "DRAFT",
          editorialDescription: "Preserve this editorial field.",
        },
      },
    },
  });
  firstProductId = first.id;

  const second = await prisma.productMirror.create({
    data: {
      pancakeProductId: secondExternalId,
      slug: secondExternalId,
      name: secondName,
      syncedAt,
    },
  });
  secondProductId = second.id;

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.31" }),
    body: {
      name: "Admin Bulk Runtime",
      email: adminEmail,
      password,
    },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);

  await prisma.user.update({
    where: { email: adminEmail },
    data: { role: "ADMIN" },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/admin-bulk-status",
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

test("admin product directory selects current-page products and bulk-updates status accessibly", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin?q=${encodeURIComponent(runId)}`, { waitUntil: "networkidle" });

  const selectAll = page.getByRole("checkbox", { name: "Chọn tất cả sản phẩm trên trang này" });
  const firstCheckbox = page.getByRole("checkbox", { name: `Chọn ${firstName}` });
  const secondCheckbox = page.getByRole("checkbox", { name: `Chọn ${secondName}` });

  await firstCheckbox.check();
  await expect(page.getByText("Đã chọn 1 sản phẩm", { exact: true })).toBeVisible();
  expect(await selectAll.evaluate((element) => (element as HTMLInputElement).indeterminate)).toBe(true);
  await expect(selectAll).not.toBeChecked();

  const draftFacet = page.locator('a[href*="status=DRAFT"]').filter({ hasText: "Nháp" }).first();
  await expect(draftFacet).toHaveAttribute("href", /status=DRAFT/);
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("status") === "DRAFT"),
    draftFacet.click(),
  ]);
  await expect(page.getByText("Đã chọn 1 sản phẩm", { exact: true })).toHaveCount(0);
  await expect(firstCheckbox).not.toBeChecked();
  await expect(secondCheckbox).not.toBeChecked();
  await expect(selectAll).not.toBeChecked();

  const allFacet = page.getByRole("link", { name: /^Tất cả/ });
  await Promise.all([
    page.waitForURL(
      (url) => url.searchParams.get("status") === null && url.searchParams.get("q") === runId,
    ),
    allFacet.click(),
  ]);

  await selectAll.check();
  await expect(firstCheckbox).toBeChecked();
  await expect(secondCheckbox).toBeChecked();
  await expect(selectAll).toBeChecked();
  expect(await selectAll.evaluate((element) => (element as HTMLInputElement).indeterminate)).toBe(false);
  await expect(page.getByText("Đã chọn 2 sản phẩm", { exact: true })).toBeVisible();

  await page.getByLabel("Trạng thái mới").selectOption("REVIEWED");
  await page.getByRole("button", { name: "Cập nhật 2 sản phẩm" }).click();
  await expect(page.getByText("Cập nhật 2 sản phẩm sang Đã duyệt?", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Xác nhận" }).click();
  const status = page
    .getByRole("status")
    .filter({ hasText: "Đã cập nhật 2 sản phẩm sang Đã duyệt." });
  await expect(status).toBeVisible();
  await expect(status).toBeFocused();
  await expect(page.getByText("Đã chọn 2 sản phẩm", { exact: true })).toHaveCount(0);

  const persisted = await prisma.productContent.findMany({
    where: { productId: { in: [firstProductId, secondProductId] } },
    select: { productId: true, status: true, editorialDescription: true },
  });
  expect(persisted).toHaveLength(2);
  expect(persisted.every((row) => row.status === "REVIEWED")).toBe(true);
  expect(persisted.find((row) => row.productId === firstProductId)?.editorialDescription).toBe(
    "Preserve this editorial field.",
  );

  // The scan runs just after a Server Action revalidation, while the dynamic head is re-streaming.
  // Axe can catch that window with no <title> yet and report a document-title violation that has
  // nothing to do with the page's accessibility. This is the test that failed that way on main at
  // af90e552 with the old one-shot toHaveTitle in place, which is why the guard now waits for the
  // title to have been continuously present rather than present at one instant.
  await expectSettledDocumentTitle(page);
  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
