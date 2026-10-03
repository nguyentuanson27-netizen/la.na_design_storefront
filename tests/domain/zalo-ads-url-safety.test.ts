import assert from "node:assert/strict";
import test from "node:test";

import {
  isZaloSafeLocation,
  isZaloSafeReferrer,
} from "../../src/integrations/zalo-ads/url-safety.ts";

const ORIGIN = "https://lanadesign.example";

test("plain storefront pages and ad-attribution parameters may be observed", () => {
  for (const href of [
    `${ORIGIN}/`,
    `${ORIGIN}/shop`,
    `${ORIGIN}/shop/ao-dai-lua-do`,
    `${ORIGIN}/checkout`,
    `${ORIGIN}/shipping#thanh-toan`,
    `${ORIGIN}/?zaclid=abc123&zsrcid=99`,
    `${ORIGIN}/shop/ao-dai?utm_source=zalo&utm_medium=cpc&utm_campaign=tet&utm_ads=1&adtid=7`,
  ]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), true, href);
  }
});

test("shopper input and order identity in the URL keep the tracker away", () => {
  for (const href of [
    // The search box writes free text straight into the URL.
    `${ORIGIN}/shop?q=alice%40example.com`,
    `${ORIGIN}/shop?q=0900000000`,
    `${ORIGIN}/shop?q=`,
    // Order flows carry the order code.
    `${ORIGIN}/checkout/success?order=LA-ABC123`,
    `${ORIGIN}/track-order?order=LA-ABC123`,
    // An attribution parameter does not launder an unreviewed one next to it.
    `${ORIGIN}/shop?utm_source=zalo&q=alice`,
    // Unreviewed parameters fail closed, even harmless-looking ones.
    `${ORIGIN}/shop?category=ao-dai`,
    // Fragments beyond a plain anchor.
    `${ORIGIN}/shop#q=alice@example.com`,
    `${ORIGIN}/shop#${"a".repeat(65)}`,
    // Not the storefront, or not a URL at all.
    "https://other.example/",
    `https://user:pass@lanadesign.example/`,
    "not a url",
    "",
  ]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), false, href);
  }
});

test("a same-origin referrer gets the location rule; another site's referrer is not storefront state", () => {
  assert.equal(isZaloSafeReferrer("", ORIGIN), true);
  assert.equal(isZaloSafeReferrer(`${ORIGIN}/shop`, ORIGIN), true);
  assert.equal(isZaloSafeReferrer("https://zalo.me/", ORIGIN), true);
  assert.equal(isZaloSafeReferrer("https://www.facebook.com/some/path?x=1", ORIGIN), true);

  assert.equal(isZaloSafeReferrer(`${ORIGIN}/shop?q=alice%40example.com`, ORIGIN), false);
  assert.equal(isZaloSafeReferrer(`${ORIGIN}/checkout/success?order=LA-ABC123`, ORIGIN), false);
  assert.equal(isZaloSafeReferrer("not a url", ORIGIN), false);
});
