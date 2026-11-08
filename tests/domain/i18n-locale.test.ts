import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  localizeHref,
  parseLocale,
  splitLocalePath,
  switchLocalePath,
} from "../../src/i18n/locale.ts";
import { createTranslator, interpolate, pick } from "../../src/i18n/translate.ts";
import { readMetaPagePath } from "../../src/integrations/meta/page-source.ts";

test("splitLocalePath reads the English prefix and leaves other paths alone", () => {
  assert.deepEqual(splitLocalePath("/en"), { locale: "en", pathname: "/" });
  assert.deepEqual(splitLocalePath("/en/shop"), { locale: "en", pathname: "/shop" });
  assert.deepEqual(splitLocalePath("/en/shop/ao-dai-1"), { locale: "en", pathname: "/shop/ao-dai-1" });
  assert.deepEqual(splitLocalePath("/shop"), { locale: DEFAULT_LOCALE, pathname: "/shop" });
  assert.deepEqual(splitLocalePath("/"), { locale: DEFAULT_LOCALE, pathname: "/" });
  // A path that merely starts with the letters is not a prefix.
  assert.deepEqual(splitLocalePath("/english"), { locale: DEFAULT_LOCALE, pathname: "/english" });
  assert.deepEqual(splitLocalePath("/entry/x"), { locale: DEFAULT_LOCALE, pathname: "/entry/x" });
});

test("localizeHref prefixes in-site pages for English and nothing else", () => {
  assert.equal(localizeHref("/shop", "en"), "/en/shop");
  assert.equal(localizeHref("/", "en"), "/en");
  assert.equal(localizeHref("/shop?q=ao&page=2#top", "en"), "/en/shop?q=ao&page=2#top");
  assert.equal(localizeHref("/?view=small", "en"), "/en?view=small");
  assert.equal(localizeHref("/shipping#thanh-toan", "en"), "/en/shipping#thanh-toan");
  // Vietnamese is the unprefixed default.
  assert.equal(localizeHref("/shop", "vi"), "/shop");
  // Idempotent.
  assert.equal(localizeHref("/en/shop", "en"), "/en/shop");
  // Not pages.
  assert.equal(localizeHref("/api/cart", "en"), "/api/cart");
  assert.equal(localizeHref("/admin/products", "en"), "/admin/products");
  assert.equal(localizeHref("/feeds/google-merchant.xml", "en"), "/feeds/google-merchant.xml");
  assert.equal(localizeHref("/brand/la-na-design-master-logo.png", "en"), "/brand/la-na-design-master-logo.png");
  assert.equal(localizeHref("/voucher-link?code=A&to=%2Fshop", "en"), "/voucher-link?code=A&to=%2Fshop");
  // Not in-site.
  assert.equal(localizeHref("https://example.com/shop", "en"), "https://example.com/shop");
  assert.equal(localizeHref("//example.com/shop", "en"), "//example.com/shop");
  assert.equal(localizeHref("mailto:a@b.c", "en"), "mailto:a@b.c");
  assert.equal(localizeHref("#main-content", "en"), "#main-content");
  assert.equal(localizeHref("?page=2", "en"), "?page=2");
});

test("switchLocalePath maps a page to its twin in either direction", () => {
  assert.equal(switchLocalePath("/shop/ao-dai-1", "en"), "/en/shop/ao-dai-1");
  assert.equal(switchLocalePath("/en/shop/ao-dai-1", "vi"), "/shop/ao-dai-1");
  assert.equal(switchLocalePath("/en", "vi"), "/");
  assert.equal(switchLocalePath("/", "en"), "/en");
  assert.equal(switchLocalePath("/en/shop", "en"), "/en/shop");
});

test("parseLocale accepts only supported locales", () => {
  assert.equal(parseLocale("en"), "en");
  assert.equal(parseLocale("vi"), "vi");
  assert.equal(parseLocale("fr"), null);
  assert.equal(parseLocale(undefined), null);
});

test("the translator returns Vietnamese source text unchanged and English from the catalog", () => {
  const messages = { "Giỏ hàng": "Cart", "Còn {count} sản phẩm": "{count} left" };
  const vi = createTranslator("vi", messages);
  const en = createTranslator("en", messages);
  assert.equal(vi("Giỏ hàng"), "Giỏ hàng");
  assert.equal(en("Giỏ hàng"), "Cart");
  assert.equal(vi("Còn {count} sản phẩm", { count: 3 }), "Còn 3 sản phẩm");
  assert.equal(en("Còn {count} sản phẩm", { count: 3 }), "3 left");
  // A missing entry falls back to the source, still interpolated.
  assert.equal(en("Chưa dịch {name}", { name: "A" }), "Chưa dịch A");
  // An unknown placeholder is left visible rather than swallowed.
  assert.equal(interpolate("Xin chào {name}", {}), "Xin chào {name}");
  assert.equal(en("toString"), "toString");
});

test("pick falls back to Vietnamese when English is absent", () => {
  assert.equal(pick("en", { vi: "a", en: "b" }), "b");
  assert.equal(pick("en", { vi: "a" }), "a");
  assert.equal(pick("vi", { vi: "a", en: "b" }), "a");
});

test("the Meta page path reads through a language prefix and keeps the deny list", () => {
  assert.equal(readMetaPagePath("/shop"), "/shop");
  assert.equal(readMetaPagePath("/en/shop"), "/shop");
  assert.equal(readMetaPagePath("/en"), "/");
  assert.equal(readMetaPagePath("/en/account"), null);
  assert.equal(readMetaPagePath("/en/login"), null);
  assert.equal(readMetaPagePath("/account"), null);
});

test("a catalog key with placeholders also translates text that was filled in by a view model", () => {
  const en = createTranslator("en", {
    "Còn {count}": "{count} left",
    "Còn {days} ngày {hours} giờ": "{days}d {hours}h left",
    "Từ {price}": "From {price}",
    "Sale từ {price}": "Sale from {price}",
    "{label}, {count} sản phẩm": "{label}, {count} items",
    "{x}": "never used",
  });
  assert.equal(en("Còn 3"), "3 left");
  assert.equal(en("Còn 2 ngày 5 giờ"), "2d 5h left");
  assert.equal(en("Từ 1.200.000₫"), "From 1.200.000₫");
  // The most specific template wins over a shorter one that also matches.
  assert.equal(en("Sale từ 900.000₫"), "Sale from 900.000₫");
  assert.equal(en("Áo dài, 3 sản phẩm"), "Áo dài, 3 items");
  // Nothing matches a bare placeholder template, and unknown text stays as written.
  assert.equal(en("Không có trong danh mục"), "Không có trong danh mục");
  // Values passed alongside a template key still fill it.
  assert.equal(en("Còn {count}", { count: 7 }), "7 left");
});
