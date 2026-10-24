import assert from "node:assert/strict";
import test from "node:test";

import {
  AD_ATTRIBUTION_COOKIE,
  AD_ATTRIBUTION_MAX_AGE_SECONDS,
  adAttributionCookieValue,
  composeOrderNote,
  formatAdAttributionNote,
  normalizeAdAttributionNote,
  serializeAdAttributionCookie,
} from "../../src/commerce/ad-attribution.ts";

const query = (search: string) => new URLSearchParams(search);

test("an ad landing's UTM parameters become one note line", () => {
  const cookie = adAttributionCookieValue(
    query("utm_source=facebook&utm_medium=paid_social&utm_campaign=summer_sale&utm_content=white_logo&utm_term=ao-dai&fbclid=IwAR0"),
  );
  assert.equal(
    formatAdAttributionNote(cookie),
    "[UTM] source=facebook;medium=paid_social;campaign=summer_sale;content=white_logo;term=ao-dai",
  );
});

test("a landing without UTM writes nothing, and a partial UTM keeps only what it has", () => {
  assert.equal(adAttributionCookieValue(query("fbclid=IwAR0&page=2")), null);
  assert.equal(adAttributionCookieValue(query("utm_source=&utm_medium=%20%20")), null);
  assert.equal(formatAdAttributionNote(adAttributionCookieValue(query("utm_campaign=tet"))), "[UTM] campaign=tet");
});

test("Vietnamese campaign names survive the cookie round trip", () => {
  const cookie = adAttributionCookieValue(query(`utm_campaign=${encodeURIComponent("Khai trương áo dài")}`));
  assert.equal(formatAdAttributionNote(cookie), "[UTM] campaign=Khai trương áo dài");
  // Next may hand the cookie back already decoded; both forms read the same.
  assert.equal(formatAdAttributionNote(decodeURIComponent(cookie as string)), "[UTM] campaign=Khai trương áo dài");
});

test("a UTM value cannot forge an order marker, a second field, or a line break", () => {
  const cookie = adAttributionCookieValue(
    query(`utm_source=${encodeURIComponent("x];medium=evil\n[ORDER:LA-1]")}&utm_campaign=${"a".repeat(500)}`),
  );
  const note = formatAdAttributionNote(cookie) as string;
  assert.ok(!note.includes("[ORDER"), note);
  assert.ok(!note.includes("\n"), note);
  assert.equal(note.match(/medium=/g), null, note);
  assert.equal(note, `[UTM] source=x__medium_evil__ORDER:LA-1_;campaign=${"a".repeat(100)}`);
  assert.equal(normalizeAdAttributionNote(note), note);
});

test("a cookie the browser rewrote is parsed field by field, not trusted", () => {
  assert.equal(formatAdAttributionNote(undefined), null);
  assert.equal(formatAdAttributionNote(""), null);
  assert.equal(formatAdAttributionNote("garbage"), null);
  assert.equal(formatAdAttributionNote("x".repeat(2_001)), null);
  assert.equal(formatAdAttributionNote("source=a;source=b;admin=1;campaign=c"), "[UTM] source=a;campaign=c");
  assert.equal(formatAdAttributionNote("%E0%A4%A"), null);
});

test("the note sent to Pancake is the shopper's note then the attribution line", () => {
  assert.equal(composeOrderNote("Giao giờ hành chính", "[UTM] source=facebook"), "Giao giờ hành chính | [UTM] source=facebook");
  assert.equal(composeOrderNote(null, "[UTM] source=facebook"), "[UTM] source=facebook");
  assert.equal(composeOrderNote("Giao giờ hành chính", null), "Giao giờ hành chính");
  assert.equal(composeOrderNote(null, null), null);
});

test("the cookie is HttpOnly, host-only, and Secure over HTTPS only", () => {
  assert.equal(
    serializeAdAttributionCookie("source%3Dfacebook", "https://www.lanadesign.vn"),
    `${AD_ATTRIBUTION_COOKIE}=source%3Dfacebook; Path=/; Max-Age=${AD_ATTRIBUTION_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly; Secure`,
  );
  assert.ok(!serializeAdAttributionCookie("v", "http://localhost:3000").includes("Secure"));
});
