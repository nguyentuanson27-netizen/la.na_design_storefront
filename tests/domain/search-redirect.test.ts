import assert from "node:assert/strict";
import test from "node:test";

import { searchRedirectTarget } from "../../src/routes/search-model.ts";

test("a /search visit with a query is forwarded to the shop results", () => {
  assert.equal(searchRedirectTarget({ q: "ao dai" }), "/shop?q=ao+dai");
  assert.equal(searchRedirectTarget({ q: "  váy  " }), "/shop?q=v%C3%A1y");
  assert.equal(searchRedirectTarget({ q: ["sv605", "x"] }), "/shop?q=sv605");
});

test("a /search visit without a usable query keeps the form", () => {
  assert.equal(searchRedirectTarget({}), null);
  assert.equal(searchRedirectTarget({ q: "" }), null);
  assert.equal(searchRedirectTarget({ q: "   " }), null);
  assert.equal(searchRedirectTarget({ q: [] }), null);
});

test("other parameters are not forwarded", () => {
  assert.equal(searchRedirectTarget({ q: "dam", utm_source: "fb", sort: "price-asc" }), "/shop?q=dam");
});
