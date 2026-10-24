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

test("a [UTM] tag the shopper typed is defused, so only the system's line carries that label", () => {
  assert.equal(composeOrderNote("[UTM] source=google;campaign=fake", null), "(UTM) source=google;campaign=fake");
  assert.equal(
    composeOrderNote("x [utm] a [ UTM ] b", "[UTM] source=facebook"),
    "x (UTM) a (UTM) b | [UTM] source=facebook",
  );
});

test("the UTM line yields to a long shopper note instead of pushing past the note limit", () => {
  const attribution = `[UTM] source=facebook;campaign=${"c".repeat(100)}`;

  const roomy = "n".repeat(1_000);
  assert.equal(composeOrderNote(roomy, attribution), `${roomy} | ${attribution}`);

  // Room for part of the line: clipped, and the whole note stays within the shopper's own limit.
  const tight = composeOrderNote("n".repeat(1_950), attribution) as string;
  assert.ok(tight.length <= 2_048, String(tight.length));
  assert.ok(tight.endsWith(attribution.slice(0, 2_048 - 1_950 - 3).trimEnd()), tight.slice(-60));

  // Not enough room for anything useful: the shopper's note goes through untouched.
  const full = "n".repeat(2_048);
  assert.equal(composeOrderNote(full, attribution), full);
  assert.equal(composeOrderNote("n".repeat(2_010), attribution), "n".repeat(2_010));
});

test("a landing's Set-Cookie header, read back as the browser would send it, yields the note line", () => {
  const value = adAttributionCookieValue(query("utm_source=facebook&utm_medium=paid&utm_campaign=Khai%20trương"));
  const setCookie = serializeAdAttributionCookie(value as string, "https://www.lanadesign.vn");
  const sent = setCookie.split(";")[0]!.slice(`${AD_ATTRIBUTION_COOKIE}=`.length);
  assert.equal(formatAdAttributionNote(sent), "[UTM] source=facebook;medium=paid;campaign=Khai trương");
});
