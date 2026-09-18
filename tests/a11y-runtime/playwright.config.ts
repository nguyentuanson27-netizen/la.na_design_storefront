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
    "homepage-hero.spec.ts",
    "homepage-taxonomy.spec.ts",
    "merchant-return-policy.spec.ts",
    "not-found-recovery.spec.ts",
    "pdp-language.spec.ts",
    "pdp-preorder-availability.spec.ts",
    "pdp-promotion.spec.ts",
    "related-products.spec.ts",
    "storefront-commerce.spec.ts",
    "storefront-composite.spec.ts",
    "storefront-media.spec.ts",
    "tracking.spec.ts",
    "variant-deep-link.spec.ts",
  ],
  workers: 1,
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
