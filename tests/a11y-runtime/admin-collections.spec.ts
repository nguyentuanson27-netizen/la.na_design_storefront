import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3213;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-collections-${runId}@example.invalid`;
const password = "admin-collections-runtime-password-123";
const collectionSlug = `admin-collections-${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) {
      throw new Error("Better Auth returned a malformed Set-Cookie header");
    }
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
      throw new Error(`Next.js a11y server exited with ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js a11y server\n${serverOutput}`);
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
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { startsWith: "admin-collections-" } },
  });
  await prisma.user.deleteMany({ where: { email: adminEmail } });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.23" }),
    body: {
      name: "Collections A11y Runtime",
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
      NEXT_DIST_DIR: ".next-test/admin-collections",
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

test("admin can maintain canonical collections with accessible success and error feedback", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      browserErrors.push(`console: ${message.text()} @ ${location.url || "unknown"}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await context.addCookies(adminCookies);
  const collectionsPath = "/admin/collections";
  await page.goto(`${BASE_URL}${collectionsPath}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 1, name: "Quản lý collections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu collection" }).first()).toBeVisible();
  // The storefront masthead does not pin on admin. Pinned it sits at z-index 50 over the whole
  // work surface, including the bulk-action toolbar that sticks to the top of the product table.
  expect(
    await page.evaluate(() => {
      const masthead = document.querySelector(".site-masthead");
      return masthead === null ? null : getComputedStyle(masthead).position;
    }),
  ).toBe("static");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);

  await page.getByLabel("Slug").fill(collectionSlug);
  await page.getByLabel("Tiêu đề").fill("City Uniform Runtime");
  await page.getByLabel("Mô tả").fill("Visible collection copy verified in a real browser.");
  await page.getByLabel("SEO title").fill("City Uniform Runtime | LA Clothing");
  await page.getByLabel("SEO description").fill("Accessible collection maintenance runtime.");
  await page.getByLabel("Pancake category IDs").fill("7, 7");
  await page.getByLabel("Vị trí trên trang chủ").selectOption("2");

  await page.getByRole("button", { name: "Lưu collection" }).first().click();
  await page.waitForURL(
    (url) => url.pathname === collectionsPath && url.searchParams.get("error") === "invalid",
  );
  const errorStatus = page.getByRole("alert").filter({ hasText: "Không thể lưu collection." });
  await expect(errorStatus).toContainText("Không thể lưu collection.");
  await expect(errorStatus).toBeFocused();

  await page.getByLabel("Slug").fill(collectionSlug);
  await page.getByLabel("Tiêu đề").fill("City Uniform Runtime");
  await page.getByLabel("Mô tả").fill("Visible collection copy verified in a real browser.");
  await page.getByLabel("SEO title").fill("City Uniform Runtime | LA Clothing");
  await page.getByLabel("SEO description").fill("Accessible collection maintenance runtime.");
  await page.getByLabel("Pancake category IDs").fill("42, 7");
  await page.getByLabel("Vị trí trên trang chủ").selectOption("2");

  await page.getByRole("button", { name: "Lưu collection" }).first().click();
  await page.waitForURL(
    (url) => url.pathname === collectionsPath && url.searchParams.get("saved") === "1",
  );
  const successStatus = page.getByRole("status");
  await expect(successStatus).toContainText("Đã lưu collection.");
  await expect(successStatus).toBeFocused();

  const persisted = await prisma.collectionDefinition.findUnique({
    where: { slug: collectionSlug },
    select: {
      title: true,
      isPublished: true,
      homepagePosition: true,
      pancakeCategoryIds: true,
    },
  });
  expect(persisted).toEqual({
    title: "City Uniform Runtime",
    isPublished: false,
    homepagePosition: 2,
    pancakeCategoryIds: [7, 42],
  });

  await page.goto(`${BASE_URL}${collectionsPath}`, { waitUntil: "networkidle" });
  const existingForm = page
    .getByRole("heading", { level: 3, name: "City Uniform Runtime" })
    .locator("xpath=ancestor::article")
    .locator("form");
  const persistedSlug = existingForm.locator('input[name="slug"]');
  await expect(persistedSlug).toHaveValue(collectionSlug);
  await expect(persistedSlug).not.toBeEditable();
  await expect(existingForm.getByLabel("Vị trí trên trang chủ")).toHaveValue("2");

  const forgedSlug = `${collectionSlug}-forged`;
  await persistedSlug.evaluate((input, nextSlug) => {
    const element = input as HTMLInputElement;
    element.readOnly = false;
    element.value = nextSlug;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, forgedSlug);
  await existingForm.getByLabel("Tiêu đề").fill("City Uniform Runtime Updated");
  await existingForm.getByRole("button", { name: "Lưu collection" }).click();
  await page.waitForURL(
    (url) => url.pathname === collectionsPath && url.searchParams.get("saved") === "1",
  );

  const forged = await prisma.collectionDefinition.findUnique({
    where: { slug: forgedSlug },
    select: { slug: true },
  });
  expect(forged).toBeNull();
  const updatedOriginal = await prisma.collectionDefinition.findUnique({
    where: { slug: collectionSlug },
    select: { title: true, homepagePosition: true },
  });
  expect(updatedOriginal).toEqual({
    title: "City Uniform Runtime Updated",
    homepagePosition: 2,
  });

  expect(
    browserErrors,
    `browser console errors; failed responses: ${JSON.stringify(failedResponses)}`,
  ).toEqual([]);
  expect(failedResponses).toEqual([]);
});
