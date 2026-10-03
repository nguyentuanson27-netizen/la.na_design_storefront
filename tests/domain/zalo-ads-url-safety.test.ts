import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isZaloSafeLocation,
  isZaloSafeReferrer,
  ZALO_SAFE_ANCHORS,
} from "../../src/integrations/zalo-ads/url-safety.ts";

const ORIGIN = "https://lanadesign.example";

test("plain storefront pages, Zalo attribution ids and the site's own anchors may be observed", () => {
  for (const href of [
    `${ORIGIN}/`,
    `${ORIGIN}/shop`,
    `${ORIGIN}/shop/ao-dai-lua-do`,
    `${ORIGIN}/checkout`,
    `${ORIGIN}/shipping#thanh-toan`,
    `${ORIGIN}/policies#bao-mat`,
    `${ORIGIN}/contact#main-content`,
    `${ORIGIN}/?zaclid=a1B2c3D4e5&zsrcid=99`,
    `${ORIGIN}/shop/ao-dai?utm_ads=1&adtid=7242087840828522496`,
  ]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), true, href);
  }
});

test("shopper input and order identity in the query keep the tracker away", () => {
  for (const href of [
    `${ORIGIN}/shop?q=alice%40example.com`,
    `${ORIGIN}/shop?q=0900000000`,
    `${ORIGIN}/shop?q=`,
    `${ORIGIN}/checkout/success?order=LA-ABC123`,
    `${ORIGIN}/track-order?order=LA-ABC123`,
    // An attribution parameter does not launder an unreviewed one next to it.
    `${ORIGIN}/shop?zaclid=abc&q=alice`,
    // Unreviewed parameters fail closed, even harmless-looking ones.
    `${ORIGIN}/shop?category=ao-dai`,
    // Free-text campaign parameters are not attribution ids.
    `${ORIGIN}/?utm_term=0900000000`,
    `${ORIGIN}/?utm_content=alice%40example.com`,
    `${ORIGIN}/?utm_source=zalo`,
  ]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), false, href);
  }
});

test("an attribution value must be an opaque id, never a customer identifier", () => {
  for (const value of [
    "0900000000",
    "84900000000",
    "%2B84900000000",
    "090-000-0000",
    "090_000_0000",
    "LA-ABC123",
    "la-abc123",
    "alice%40example.com",
    "Nguy%E1%BB%85n%20V%C4%83n%20A",
    "12%20Le%20Loi",
    "",
    "x".repeat(129),
  ]) {
    for (const key of ["zaclid", "zsrcid", "utm_ads", "adtid"]) {
      const href = `${ORIGIN}/?${key}=${value}`;
      assert.equal(isZaloSafeLocation(href, ORIGIN), false, href);
    }
  }
});

test("only the site's own anchors are safe fragments", () => {
  for (const href of [
    `${ORIGIN}/#0900000000`,
    `${ORIGIN}/#LA-ABC123`,
    `${ORIGIN}/#alice@example.com`,
    `${ORIGIN}/shop#q=alice`,
    `${ORIGIN}/shipping#thanh-toan-extra`,
    `${ORIGIN}/#`.concat("a".repeat(20)),
  ]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), false, href);
  }
});

test("not the storefront, or not a URL at all, is unsafe", () => {
  for (const href of ["https://other.example/", `https://user:pass@lanadesign.example/`, "not a url", ""]) {
    assert.equal(isZaloSafeLocation(href, ORIGIN), false, href);
  }
});

test("a same-origin referrer gets the location rule; another site's referrer must be origin-only", () => {
  assert.equal(isZaloSafeReferrer("", ORIGIN), true);
  assert.equal(isZaloSafeReferrer(`${ORIGIN}/shop`, ORIGIN), true);
  assert.equal(isZaloSafeReferrer("https://zalo.me/", ORIGIN), true);
  assert.equal(isZaloSafeReferrer("https://www.facebook.com/", ORIGIN), true);

  // The referring site's own policy decides what it sends; ours does not limit what arrives.
  assert.equal(isZaloSafeReferrer("https://other.example/path?email=alice%40example.com", ORIGIN), false);
  assert.equal(isZaloSafeReferrer("https://other.example/?email=alice%40example.com", ORIGIN), false);
  assert.equal(isZaloSafeReferrer("https://other.example/profile/0900000000", ORIGIN), false);
  assert.equal(isZaloSafeReferrer("https://other.example/#alice", ORIGIN), false);
  assert.equal(isZaloSafeReferrer("https://user:pass@other.example/", ORIGIN), false);

  assert.equal(isZaloSafeReferrer(`${ORIGIN}/shop?q=alice%40example.com`, ORIGIN), false);
  assert.equal(isZaloSafeReferrer(`${ORIGIN}/checkout/success?order=LA-ABC123`, ORIGIN), false);
  assert.equal(isZaloSafeReferrer(`${ORIGIN}/#0900000000`, ORIGIN), false);
  assert.equal(isZaloSafeReferrer("not a url", ORIGIN), false);
});

test("every in-page anchor the storefront links to is on the safe list", async () => {
  // A new anchor that is missing here only stops Zalo reporting on that link (fail-closed); this
  // keeps the list honest so the skip link and policy hub do not silently cut tracking off.
  const root = fileURLToPath(new URL("../../src/", import.meta.url));
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") await walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !path.includes("/admin/")) {
        files.push(path);
      }
    }
  };
  await walk(root);

  const linked = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:href=["']|["'`]\/[a-z0-9/-]*)#([A-Za-z0-9_-]+)["'`]/g)) {
      linked.add(match[1]!);
    }
  }
  assert.ok(linked.size > 0, "expected to find the storefront's in-page links");
  assert.deepEqual([...linked].filter((anchor) => !ZALO_SAFE_ANCHORS.has(anchor)), []);
});
