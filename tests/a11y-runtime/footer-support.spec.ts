import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BUYER_AXE_TAGS } from "./axe-tags";
import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
} from "../../src/content/public-brand-facts.ts";

const HOST = "127.0.0.1";
const PORT = 3224;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`U5 footer server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/search`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U5 footer server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) server.kill("SIGKILL");
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/footer-support",
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_URL: BASE_URL,
      LA_SHIPPING_FEE_VND: "25000",
      LA_FREE_SHIPPING_SUBTOTAL_VND: "750000",
      LA_FREE_SHIPPING_MIN_QUANTITY: "4",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
});

test("U5 footer exposes canonical factual trust without unapproved support routes", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/search`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("Thanh toán khi nhận hàng (COD).");
  await expect(footer).toContainText(/Đơn trên 750\.000.*hoặc từ 4 sản phẩm\./);
  await expect(footer).toContainText("Tra cứu trạng thái đơn COD bằng mã đơn và số điện thoại đã dùng khi đặt hàng.");
  await expect(footer.locator('a[href="/track-order"]')).toBeVisible();

  // U32b/B2 — the contact facts the Organization JSON-LD marks up have to be facts a reader can
  // actually see, and the footer is the site-wide surface that carries them. Asserted against the
  // fact authority, not against literals, so the visible text and the markup cannot drift apart.
  await expect(footer).toContainText(PUBLIC_CONTACT_FACTS.telephone);
  await expect(footer).toContainText(PUBLIC_CONTACT_FACTS.email);
  await expect(footer).toContainText(describePublicAddress());
  await expect(footer).toContainText(describePublicSupportHours());
  // Visible text is the owner's spelling; the dial target and the Organization markup both carry
  // the international one. Both come from the authority, so they cannot describe two numbers.
  await expect(
    footer.locator(`a[href="tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}"]`),
  ).toBeVisible();
  await expect(footer.locator(`a[href="mailto:${PUBLIC_CONTACT_FACTS.email}"]`)).toBeVisible();
  await expect(footer.locator(`a[href="${PUBLIC_CONTACT_FACTS.fanpageUrl}"]`)).toBeVisible();

  // U33a built `/about` and `/contact`, U33b built `/shipping` and `/returns`, and U33c built
  // `/size-guide` from owner-approved facts, so they are now linked. The rest of the list stays absent:
  // those routes have no approved facts behind them yet, and linking a page this repository has not built
  // is how a 404 reaches a buyer looking for a policy.
  for (const href of ["/about", "/contact", "/shipping", "/returns", "/size-guide"]) {
    await expect(footer.locator(`a[href="${href}"]`)).toBeVisible();
  }
  for (const href of ["/shipping-returns", "/faq"]) {
    await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(0);
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});
