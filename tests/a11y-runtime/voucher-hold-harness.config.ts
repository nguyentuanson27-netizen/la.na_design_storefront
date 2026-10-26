import { defineConfig, devices } from "@playwright/test";

/**
 * Runs only the voucher hold harness spec, against a production build served by `next start` that
 * `scripts/voucher-hold-harness.ts` starts. Deliberately NOT part of the shared browser suite: it needs its own
 * artifact and its own env.
 *
 * Trace, video and screenshots are off on purpose: a Playwright trace stores request headers, cookies and response
 * bodies, which would put the cart cookie and the signed proof into an artifact. The spec keeps its own sanitized
 * network log instead.
 */
export default defineConfig({
  testDir: ".",
  testMatch: ["voucher-hold-harness.spec.ts"],
  use: {
    ...devices["Desktop Chrome"],
    trace: "off",
    video: "off",
    screenshot: "off",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? "[]") } }
      : {}),
  },
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "line",
});
