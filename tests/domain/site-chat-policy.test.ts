import assert from "node:assert/strict";
import test from "node:test";

import { isAdminPath, siteChatFor } from "../../src/components/brand/site-chat-policy.ts";

const ZALO = "https://zalo.me/0900000000";

test("every storefront page shows the Zalo link button", () => {
  for (const pathname of ["/", "/shop", "/shop/vay-v9355", "/cart", "/checkout", "/administrator", "/shop/admin", "/adminx"]) {
    assert.equal(siteChatFor({ pathname, zaloHref: ZALO }), "zalo", pathname);
  }
});

test("admin shows no chat", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/promotions", "/admin/products/p1"]) {
    assert.equal(isAdminPath(pathname), true);
    assert.equal(siteChatFor({ pathname, zaloHref: ZALO }), "none");
  }
  for (const pathname of ["/", "/administrator", "/shop/admin", "/adminx"]) {
    assert.equal(isAdminPath(pathname), false, `${pathname} is not admin`);
  }
});

test("without a Zalo link to point at there is no button, rather than a dead one", () => {
  assert.equal(siteChatFor({ pathname: "/", zaloHref: null }), "none");
});
