import assert from "node:assert/strict";
import test from "node:test";

import {
  VOUCHER_INTENT_COOKIE,
  VOUCHER_REDIRECT_HEADERS,
  clearVoucherIntentCookie,
  isSafeLandingTarget,
  planVoucherLinkRedirect,
  readVoucherIntentCookie,
  serializeVoucherIntentCookie,
} from "../../src/commerce/voucher-marketing-link.ts";

const plan = (pathname: string, search: string, method = "GET") => planVoucherLinkRedirect({ method, pathname, search });

test("AC-40: a PRIVATE code link is redirected before any document loads, to a clean URL without the code", () => {
  const redirect = plan("/shop/vay-dam-hoa", "?voucher=KOL50")!;
  assert.equal(redirect.cleanTarget, "/shop/vay-dam-hoa");
  const handler = new URL(redirect.handlerPath, "https://x.invalid");
  assert.equal(handler.pathname, "/voucher-link");
  assert.equal(handler.searchParams.get("code"), "KOL50");
  assert.equal(handler.searchParams.get("to"), "/shop/vay-dam-hoa");
  // The clean URL the browser ends up on never contains the code.
  assert.doesNotMatch(redirect.cleanTarget, /KOL50|voucher/i);
});

test("other query parameters (UTM, fbclid, variant) survive the redirect, in order", () => {
  const redirect = plan("/shop/vay-dam-hoa", "?utm_source=fb&voucher=KOL50&fbclid=abc&v=2")!;
  assert.equal(redirect.cleanTarget, "/shop/vay-dam-hoa?utm_source=fb&fbclid=abc&v=2");
});

test("the redirects carry no-referrer and no-store, so the code is not in a Referer or a shared cache", () => {
  assert.equal(VOUCHER_REDIRECT_HEADERS["Referrer-Policy"], "no-referrer");
  assert.equal(VOUCHER_REDIRECT_HEADERS["Cache-Control"], "private, no-store");
});

test("a malformed, oversized or repeated code is still stripped from the URL but nothing is applied", () => {
  for (const search of ["?voucher=bad%20code!", `?voucher=${"A".repeat(200)}`, "?voucher=", "?voucher=AB", "?voucher=KOL50&voucher=OTHER99"]) {
    const redirect = plan("/shop/vay-dam-hoa", search)!;
    assert.equal(redirect.handlerPath, redirect.cleanTarget, search);
    assert.equal(redirect.cleanTarget, "/shop/vay-dam-hoa", search);
  }
});

test("only GET and HEAD to landing pages are touched; everything else passes through", () => {
  assert.equal(plan("/shop/x", "?voucher=KOL50", "POST"), null);
  assert.equal(plan("/shop/x", "", "GET"), null);
  assert.equal(plan("/shop/x", "?utm_source=fb"), null);
  assert.notEqual(plan("/shop/x", "?voucher=KOL50", "HEAD"), null);
  for (const path of ["/admin/promotions/vouchers", "/api/auth/x", "/checkout", "/voucher-link", "/shop/a/b", "/policies/returns", "/_next/static/x"]) {
    assert.equal(plan(path, "?voucher=KOL50"), null, path);
  }
  for (const path of ["/", "/shop", "/cart", "/shop/vay-dam-hoa", "/ao-dai/ao-dai-tet", "/sale"]) assert.notEqual(plan(path, "?voucher=KOL50"), null, path);
});

test("the landing target is never an open redirect", () => {
  for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "/shop/x\r\nSet-Cookie: a=b", "javascript:alert(1)", "", null, undefined, 5, "/admin", "/shop/x?voucher=KOL50", `/shop/${"a".repeat(600)}`, "shop/x"]) {
    assert.equal(isSafeLandingTarget(bad), false, String(bad));
  }
  for (const good of ["/", "/shop/vay-dam-hoa", "/shop/x?utm_source=fb", "/cart", "/ao-dai/cach-tan"]) assert.equal(isSafeLandingTarget(good), true, good);
});

test("the pending-code cookie is HttpOnly, host-only, short-lived and canonical; Secure on https", () => {
  const https = serializeVoucherIntentCookie(" kol50 ", "https://www.lanadesign.vn");
  assert.match(https, new RegExp(`^${VOUCHER_INTENT_COOKIE}=KOL50; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly; Secure$`));
  assert.doesNotMatch(serializeVoucherIntentCookie("KOL50", "http://localhost:3000"), /Secure/);
  assert.doesNotMatch(https, /Domain=/i);
  assert.throws(() => serializeVoucherIntentCookie("bad code!", "https://x.invalid"), TypeError);
  assert.match(clearVoucherIntentCookie("https://www.lanadesign.vn"), /Max-Age=0/);
});

test("reading the cookie re-validates it; a tampered value is ignored", () => {
  assert.equal(readVoucherIntentCookie("kol50"), "KOL50");
  assert.equal(readVoucherIntentCookie(undefined), null);
  for (const bad of ["", "ab", "bad code", "<script>", "A".repeat(40)]) assert.equal(readVoucherIntentCookie(bad), null);
});
