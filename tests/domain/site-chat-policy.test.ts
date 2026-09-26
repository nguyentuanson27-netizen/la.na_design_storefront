import assert from "node:assert/strict";
import test from "node:test";

import { isAdminPath, siteChatFor } from "../../src/components/brand/site-chat-policy.ts";
import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../../src/commerce/storefront-origin.ts";

const base = {
  pathname: "/",
  pancakePageId: "web_lanadesign",
  pancakeHosts: [OFFICIAL_PRODUCTION_STOREFRONT_HOST, LEGACY_TEMPORARY_STOREFRONT_HOST],
} as const;

test("the Pancake widget loads only on the exact registered hosts the browser is on", () => {
  assert.equal(siteChatFor({ ...base, hostname: OFFICIAL_PRODUCTION_STOREFRONT_HOST }), "pancake");
  assert.equal(siteChatFor({ ...base, hostname: LEGACY_TEMPORARY_STOREFRONT_HOST }), "pancake");

  for (const hostname of [
    "lanadesign.vn",
    "127.0.0.1",
    "localhost",
    "staging.lanadesign.vn",
    `${OFFICIAL_PRODUCTION_STOREFRONT_HOST}.example.com`,
    `evil-${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`,
    `${LEGACY_TEMPORARY_STOREFRONT_HOST}.example.com`,
  ]) {
    assert.equal(siteChatFor({ ...base, hostname }), "messenger", `${hostname} falls back to Messenger`);
  }
});

test("without a Pancake page id the production host keeps the Messenger button", () => {
  assert.equal(
    siteChatFor({ ...base, hostname: OFFICIAL_PRODUCTION_STOREFRONT_HOST, pancakePageId: undefined }),
    "messenger",
  );
});

test("admin shows no chat on any host, and nothing is chosen before the host is known", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/promotions", "/admin/products/p1"]) {
    assert.equal(isAdminPath(pathname), true);
    assert.equal(siteChatFor({ ...base, pathname, hostname: OFFICIAL_PRODUCTION_STOREFRONT_HOST }), "none");
    assert.equal(siteChatFor({ ...base, pathname, hostname: "127.0.0.1" }), "none");
  }
  for (const pathname of ["/", "/administrator", "/shop/admin", "/adminx"]) {
    assert.equal(isAdminPath(pathname), false, `${pathname} is not admin`);
  }

  assert.equal(siteChatFor({ ...base, hostname: null }), "none");
});
