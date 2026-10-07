import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginHref, resolveSafeReturnPath } from "../../src/auth/return-path.ts";

test("a same-site path, with its query and hash, is accepted as is", () => {
  for (const path of ["/", "/shop/set-quan-ha-lam", "/shop/a?variant=2#reviews", "/collections/xa-hang-chao-thu"]) {
    assert.equal(resolveSafeReturnPath(path), path);
  }
});

test("anything that could leave the site, or is not a path, is refused", () => {
  for (const value of [
    null,
    undefined,
    "",
    "shop/a",
    "https://evil.example/shop/a",
    "//evil.example",
    "//evil.example/shop",
    "/\\evil.example",
    "/shop\\..\\evil",
    "javascript:alert(1)",
    "/shop/a\nSet-Cookie: x=1",
    "/shop/a\u0000",
    `/${"a".repeat(600)}`,
  ]) {
    assert.equal(resolveSafeReturnPath(value), null, String(value));
  }
});

test("the sign-in page is never a return target, which would loop", () => {
  for (const value of ["/login", "/login?next=%2Fshop%2Fa", "/login#sign-up-title"]) {
    assert.equal(resolveSafeReturnPath(value), null, value);
  }
});

test("buildLoginHref encodes a safe target and drops an unsafe one", () => {
  assert.equal(buildLoginHref("/shop/set-quan-ha-lam"), "/login?next=%2Fshop%2Fset-quan-ha-lam");
  assert.equal(buildLoginHref("https://evil.example"), "/login");
});
