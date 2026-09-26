import { defineConfig, devices } from "@playwright/test";

const adminDesktopTests = [
  "admin-bulk-operations.spec.ts",
  "admin-commerce-v3.spec.ts",
  "admin-editor.spec.ts",
  "admin-editor-compact.spec.ts",
];

export default defineConfig({
  testDir: ".",
  testMatch: [
    "admin-bulk-operations.spec.ts",
    "admin-bulk-status.spec.ts",
    "admin-collections.spec.ts",
    "admin-commerce-v3.spec.ts",
    "admin-editor.spec.ts",
    "admin-editor-compact.spec.ts",
    "admin-promotions.spec.ts",
    "checkout.spec.ts",
    "collection-breadcrumb.spec.ts",
    "collection-landing.spec.ts",
    "commerce-events.spec.ts",
    "discovery.spec.ts",
    "document-title-watch.spec.ts",
    "editorial.spec.ts",
    "evergreen-pages.spec.ts",
    "facebook-pixel.spec.ts",
    "facebook-pixel-disabled.spec.ts",
    "flash-sale-freshness.spec.ts",
    "footer-support.spec.ts",
    "homepage-composition.spec.ts",
    "homepage-hero.spec.ts",
    "homepage-refresh-acceptance.spec.ts",
    "homepage-taxonomy.spec.ts",
    "inventory-truth.spec.ts",
    "merchant-return-policy.spec.ts",
    "mobile-storefront-rhythm.spec.ts",
    "not-found-recovery.spec.ts",
    "pancake-chat-admin-isolation.spec.ts",
    "pdp-language.spec.ts",
    "pdp-preorder-availability.spec.ts",
    "pdp-promotion.spec.ts",
    "related-products.spec.ts",
    "storefront-commerce.spec.ts",
    "storefront-listing-consistency.spec.ts",
    "storefront-composite.spec.ts",
    "storefront-media.spec.ts",
    "tracking.spec.ts",
    "variant-deep-link.spec.ts",
  ],
  workers: 1,
  /*
   * One retry on CI, none locally.
   *
   * The suite is ~150 browser tests run serially, and with no retries a single wobbly one takes
   * the whole run -- and the pull request -- down with it. That was 44% of completed runs over the
   * sampled window, always in the shape "1 failed, ~150 passed", with a different test each time.
   *
   * A retry does not hide anything: Playwright reports a test that only passes on the second
   * attempt as `flaky` and prints it in the summary, so the signal stays in the log and can be
   * fixed, rather than being a red run someone re-triggers without reading.
   */
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "line",
  projects: [
    {
      name: "chromium-admin-desktop",
      testMatch: adminDesktopTests,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "chromium-mobile",
      testIgnore: adminDesktopTests,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
