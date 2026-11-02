import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { storefrontCacheKey } from "../../src/commerce/storefront-cache-key.ts";

describe("storefront cache key", () => {
  it("keeps size and colour apart when the shopper's text contains the old separator", () => {
    assert.notEqual(
      storefrontCacheKey(["disc-page", 1, "M:Do", "Xanh"]),
      storefrontCacheKey(["disc-page", 1, "M", "Do:Xanh"]),
    );
  });

  it("tells an absent field from an empty one, and a number from its text", () => {
    assert.notEqual(storefrontCacheKey(["a", null]), storefrontCacheKey(["a", ""]));
    assert.notEqual(storefrontCacheKey(["a", 1]), storefrontCacheKey(["a", "1"]));
    assert.equal(storefrontCacheKey(["a", undefined]), storefrontCacheKey(["a", null]));
  });
});
