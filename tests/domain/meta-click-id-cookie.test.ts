import assert from "node:assert/strict";
import test from "node:test";

import {
  META_CLICK_ID_MAX_AGE_SECONDS,
  nextMetaClickIdCookie,
  serializeMetaClickIdCookie,
} from "../../src/integrations/meta/click-id-cookie.ts";
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
    serializeMetaClickIdCookie("fb.1.1760000000123.IwAR0abc", "https://www.lanadesign.vn"),
    `_fbc=fb.1.1760000000123.IwAR0abc; Path=/; Max-Age=${META_CLICK_ID_MAX_AGE_SECONDS}; SameSite=Lax; Domain=lanadesign.vn; Secure`,
  );
});

test("other hosts get a host-only cookie, and a local HTTP origin is not marked Secure", () => {
  const staging = serializeMetaClickIdCookie("fb.1.1760000000123.IwAR0abc", "https://la.lanadesign.vn");
  assert.doesNotMatch(staging, /Domain=/);
  assert.match(staging, /; Secure$/);

  const local = serializeMetaClickIdCookie("fb.1.1760000000123.IwAR0abc", "http://127.0.0.1:3315");
  assert.doesNotMatch(local, /Domain=|Secure|HttpOnly/);
});
