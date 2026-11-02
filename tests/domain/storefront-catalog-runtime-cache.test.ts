import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:5432/placeholder";

describe("Storefront catalog runtime cache", () => {
  it("clearStorefrontRuntimeCaches executes idempotently without throwing", async () => {
    const { clearStorefrontRuntimeCaches } = await import(
      "../../src/commerce/storefront-catalog-runtime.ts"
    );
    assert.doesNotThrow(() => {
      clearStorefrontRuntimeCaches();
      clearStorefrontRuntimeCaches();
    });
  });
});
