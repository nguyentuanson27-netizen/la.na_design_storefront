import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["v1-performance-compare.spec.ts"],
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  projects: [
    {
      name: "chromium-v1-performance",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
