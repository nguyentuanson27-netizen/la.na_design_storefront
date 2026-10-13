import assert from "node:assert/strict";
import test from "node:test";

import {
  isMetaCookieNavigation,
  META_CLICK_ID_MAX_AGE_SECONDS,
  nextMetaClickIdCookie,
  nextMetaVisitorIdCookie,
  readMetaVisitorId,
  serializeMetaFirstPartyCookie,
} from "../../src/integrations/meta/first-party-cookies.ts";
import { buildMetaUserData } from "../../src/integrations/meta/conversions-api.ts";
import { validateMetaCookie } from "../../src/integrations/meta/conversions-api.ts";

const NOW = 1_760_000_000_123;

test("an ad click's fbclid becomes an _fbc the server validator accepts", () => {
  const value = nextMetaClickIdCookie({ fbclid: "IwAR0abc-DEF_123", existing: undefined, nowMs: NOW });
  assert.equal(value, `fb.1.${NOW}.IwAR0abc-DEF_123`);
  assert.equal(validateMetaCookie(value, "fbc"), value);
});

test("a reload of the same click keeps the original click time", () => {
  const existing = "fb.1.1750000000000.IwAR0same";
  assert.equal(nextMetaClickIdCookie({ fbclid: "IwAR0same", existing, nowMs: NOW }), null);
  // The pixel's own value, with its optional trailing segment, is the same click too.
  assert.equal(nextMetaClickIdCookie({ fbclid: "IwAR0same", existing: `${existing}.AbCd`, nowMs: NOW }), null);
});

test("a new click replaces the old one, and a malformed cookie is replaced rather than trusted", () => {
  assert.equal(
    nextMetaClickIdCookie({ fbclid: "IwAR0new", existing: "fb.1.1750000000000.IwAR0old", nowMs: NOW }),
    `fb.1.${NOW}.IwAR0new`,
  );
  assert.equal(
    nextMetaClickIdCookie({ fbclid: "IwAR0new", existing: "garbage", nowMs: NOW }),
    `fb.1.${NOW}.IwAR0new`,
  );
});

test("no click, or a click id outside Meta's shape, writes nothing", () => {
  for (const fbclid of [null, "", "has space", "a.b", "<script>", "x".repeat(401)]) {
    assert.equal(nextMetaClickIdCookie({ fbclid, existing: undefined, nowMs: NOW }), null, String(fbclid));
  }
  assert.equal(nextMetaClickIdCookie({ fbclid: "IwAR0abc", existing: undefined, nowMs: Number.NaN }), null);
});

test("production writes on the registrable domain the pixel uses, over HTTPS only", () => {
  assert.equal(
    serializeMetaFirstPartyCookie("_fbc", "fb.1.1760000000123.IwAR0abc", META_CLICK_ID_MAX_AGE_SECONDS, "https://www.lanadesign.vn"),
    `_fbc=fb.1.1760000000123.IwAR0abc; Path=/; Max-Age=${META_CLICK_ID_MAX_AGE_SECONDS}; SameSite=Lax; Domain=lanadesign.vn; Secure`,
  );
});

test("other hosts get a host-only cookie, and a local HTTP origin is not marked Secure", () => {
  const staging = serializeMetaFirstPartyCookie("_fbc", "fb.1.1760000000123.IwAR0abc", META_CLICK_ID_MAX_AGE_SECONDS, "https://la.lanadesign.vn");
  assert.doesNotMatch(staging, /Domain=/);
  assert.match(staging, /; Secure$/);

  const local = serializeMetaFirstPartyCookie("_fbc", "fb.1.1760000000123.IwAR0abc", META_CLICK_ID_MAX_AGE_SECONDS, "http://127.0.0.1:3315");
  assert.doesNotMatch(local, /Domain=|Secure|HttpOnly/);
});

const VISITOR_ID = "0123456789abcdef".repeat(4);

test("a request without a valid visitor ID gets 256 random bits as 64 lowercase hex digits", () => {
  const fixed = (bytes: Uint8Array) => bytes.fill(0xab);
  assert.equal(nextMetaVisitorIdCookie(undefined, fixed), "ab".repeat(32));
  for (const existing of ["", "not-hex", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
    assert.equal(nextMetaVisitorIdCookie(existing, fixed), "ab".repeat(32), existing);
  }
  const random = nextMetaVisitorIdCookie(undefined)!;
  assert.match(random, /^[0-9a-f]{64}$/);
  assert.notEqual(nextMetaVisitorIdCookie(undefined), random);
});

test("a valid visitor ID is kept, never rotated", () => {
  assert.equal(nextMetaVisitorIdCookie(VISITOR_ID), null);
  assert.equal(readMetaVisitorId(VISITOR_ID), VISITOR_ID);
  assert.equal(readMetaVisitorId("x"), null);
  assert.equal(readMetaVisitorId(null), null);
});

test("the visitor ID reaches Meta as external_id unchanged, and nothing else does", () => {
  const base = { phone: null, fullName: null, clientIpAddress: null, clientUserAgent: null, fbp: null, fbc: null };
  assert.deepEqual(buildMetaUserData({ ...base, externalId: VISITOR_ID }), { external_id: [VISITOR_ID] });
  assert.deepEqual(buildMetaUserData({ ...base, externalId: "someone@example.com" }), {});
  assert.deepEqual(buildMetaUserData({ ...base, externalId: null }), {});
});

test("the visitor ID cookie is scoped like the click ID, for a year", () => {
  assert.equal(
    serializeMetaFirstPartyCookie("la_vid", VISITOR_ID, 365 * 24 * 60 * 60, "https://www.lanadesign.vn"),
    `la_vid=${VISITOR_ID}; Path=/; Max-Age=31536000; SameSite=Lax; Domain=lanadesign.vn; Secure`,
  );
});

function navigation(method: string, pathname: string, headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return isMetaCookieNavigation({ method, pathname, headers: { get: (name) => lower.get(name) ?? null } });
}
const DOCUMENT = { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml" };

test("a browser's load of a public storefront page is eligible for the cookies", () => {
  for (const path of ["/", "/shop", "/shop/ao-dai-lua", "/collections/sale"]) {
    assert.equal(navigation("GET", path, DOCUMENT), true, path);
  }
  // No Sec-Fetch-Dest at all: an HTML Accept still marks a page load.
  assert.equal(navigation("GET", "/shop", { accept: "text/html" }), true);
});

test("private paths, files and the internal 404 rewrite never get them", () => {
  for (const path of ["/admin", "/admin/orders", "/account", "/login", "/api/meta/events",
    "/icon.svg", "/robots.txt", "/__unresolved-product", "/Shop"]) {
    assert.equal(navigation("GET", path, DOCUMENT), false, path);
  }
});

test("HEAD, router fetches, prefetch and non-document requests never get them", () => {
  assert.equal(navigation("HEAD", "/shop", DOCUMENT), false);
  assert.equal(navigation("POST", "/shop", DOCUMENT), false);
  // An App Router navigation or prefetch, as the proxy sees it once Next has removed the Flight headers.
  assert.equal(navigation("GET", "/shop", { "sec-fetch-dest": "empty", accept: "text/x-component" }), false);
  assert.equal(navigation("GET", "/shop", { accept: "text/x-component" }), false);
  assert.equal(navigation("GET", "/shop", { ...DOCUMENT, "sec-purpose": "prefetch;prerender" }), false);
  assert.equal(navigation("GET", "/shop", { ...DOCUMENT, purpose: "prefetch" }), false);
  assert.equal(navigation("GET", "/shop", { "sec-fetch-dest": "empty", accept: "*/*" }), false);
  assert.equal(navigation("GET", "/shop", { "sec-fetch-dest": "image", accept: "text/html" }), false);
  assert.equal(navigation("GET", "/shop", { accept: "*/*" }), false);
});
