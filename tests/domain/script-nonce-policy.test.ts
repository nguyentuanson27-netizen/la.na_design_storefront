import assert from "node:assert/strict";
import test from "node:test";

import {
  CSP_NONCE_REQUEST_HEADER,
  buildStrictScriptPolicy,
  createScriptNonce,
  isScriptNonce,
  readRequestScriptNonce,
  readStrictScriptPolicyMode,
  strictScriptPolicyHeaders,
} from "../../src/security/script-nonce-policy.ts";

const BASE =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://chat-plugin.pancake.vn; "
  + "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; "
  + "upgrade-insecure-requests;";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";

const directive = (policy: string, name: string) =>
  policy.split("; ").find((entry) => entry === name || entry.startsWith(`${name} `));

test("nonces are 16 random bytes in base64 and never repeat", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const nonce = createScriptNonce();
    assert.ok(isScriptNonce(nonce), nonce);
    seen.add(nonce);
  }
  assert.equal(seen.size, 200);

  for (const value of ["", "abc", `${NONCE}x`, "AAAAAAAAAAAAAAAAAAAAAA'=", null, 42]) {
    assert.equal(isScriptNonce(value), false, String(value));
  }
});

test("the mode defaults to report-only and an unknown value never disables or enforces", () => {
  assert.equal(readStrictScriptPolicyMode({}), "report-only");
  assert.equal(readStrictScriptPolicyMode({ LA_CSP_STRICT_SCRIPTS: "" }), "report-only");
  assert.equal(readStrictScriptPolicyMode({ LA_CSP_STRICT_SCRIPTS: " enforce " }), "enforce");
  assert.equal(readStrictScriptPolicyMode({ LA_CSP_STRICT_SCRIPTS: "off" }), "off");
  assert.equal(readStrictScriptPolicyMode({ LA_CSP_STRICT_SCRIPTS: "ENFORCE" }), "report-only");
  assert.equal(readStrictScriptPolicyMode({ LA_CSP_STRICT_SCRIPTS: "true" }), "report-only");
});

test("the strict policy leads script-src with the nonce and strict-dynamic, keeping the fallbacks", () => {
  const policy = buildStrictScriptPolicy(BASE, NONCE, "enforce");

  assert.equal(
    directive(policy, "script-src"),
    `script-src 'nonce-${NONCE}' 'strict-dynamic' 'self' 'unsafe-inline' https://chat-plugin.pancake.vn`,
  );
  // Every other directive is the baseline's, unchanged.
  for (const name of ["default-src", "style-src", "object-src", "base-uri", "frame-ancestors", "upgrade-insecure-requests"]) {
    assert.equal(directive(policy, name), directive(BASE.replace(/;$/, ""), name), name);
  }
  assert.equal(directive(policy, "report-uri"), "report-uri /api/csp-report");
});

test("report-only drops upgrade-insecure-requests, which browsers ignore there", () => {
  const policy = buildStrictScriptPolicy(BASE, NONCE, "report-only");
  assert.equal(directive(policy, "upgrade-insecure-requests"), undefined);
  assert.match(policy, /script-src 'nonce-/);
});

test("a baseline without script-src, or a malformed nonce, is refused", () => {
  assert.throws(() => buildStrictScriptPolicy("default-src 'self'", NONCE, "enforce"), /no script-src/);
  assert.throws(() => buildStrictScriptPolicy(BASE, "abc' 'unsafe-eval", "enforce"), /16 random bytes/);
});

test("the browser cannot choose the nonce or the policy rendering reads it from", () => {
  const incoming = new Headers({
    "content-security-policy": "script-src 'nonce-attacker'",
    "content-security-policy-report-only": "script-src 'nonce-attacker'",
    [CSP_NONCE_REQUEST_HEADER]: "BBBBBBBBBBBBBBBBBBBBBB==",
    accept: "text/html",
  });

  const off = strictScriptPolicyHeaders(incoming, BASE, "off", NONCE);
  assert.equal(off.response, null);
  assert.equal(off.request.get("content-security-policy"), null);
  assert.equal(off.request.get("content-security-policy-report-only"), null);
  assert.equal(off.request.get(CSP_NONCE_REQUEST_HEADER), null);
  assert.equal(off.request.get("accept"), "text/html");

  const reportOnly = strictScriptPolicyHeaders(incoming, BASE, "report-only", NONCE);
  assert.equal(reportOnly.response?.name, "content-security-policy-report-only");
  assert.deepEqual(reportOnly.response?.values, [buildStrictScriptPolicy(BASE, NONCE, "report-only")]);
  assert.equal(reportOnly.request.get("content-security-policy"), null);
  assert.equal(reportOnly.request.get("content-security-policy-report-only"), reportOnly.response?.values[0]);
  assert.equal(reportOnly.request.get(CSP_NONCE_REQUEST_HEADER), NONCE);

  const enforce = strictScriptPolicyHeaders(incoming, BASE, "enforce", NONCE);
  assert.equal(enforce.response?.name, "content-security-policy");
  assert.equal(enforce.request.get("content-security-policy"), enforce.response?.values[0]);
  assert.equal(enforce.request.get("content-security-policy-report-only"), null);
  assert.match(enforce.response!.values[0]!, new RegExp(`'nonce-${NONCE.replaceAll("+", "\\+")}'`));

  // The incoming headers object is not modified.
  assert.equal(incoming.get(CSP_NONCE_REQUEST_HEADER), "BBBBBBBBBBBBBBBBBBBBBB==");
});

test("enforce re-sends the baseline after the strict policy, so Next still finds the nonce first", () => {
  const { response } = strictScriptPolicyHeaders(new Headers(), BASE, "enforce", NONCE);
  assert.deepEqual(response?.values, [buildStrictScriptPolicy(BASE, NONCE, "enforce"), BASE]);

  // Next copies the proxy's response header onto the request and reads the first script-src
  // there (next/dist/server/app-render/get-script-nonce-from-header). Joined the way Headers
  // joins repeated values, that must still be the nonce-bearing one.
  const joined = new Headers();
  for (const value of response!.values) joined.append(response!.name, value);
  const firstScriptSrc = joined.get(response!.name)!.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith("script-src"));
  assert.equal(firstScriptSrc?.split(/\s+/)[1], `'nonce-${NONCE}'`);
});

test("server components only accept a well-formed nonce", () => {
  assert.equal(readRequestScriptNonce(new Headers({ [CSP_NONCE_REQUEST_HEADER]: NONCE })), NONCE);
  assert.equal(readRequestScriptNonce(new Headers()), undefined);
  assert.equal(readRequestScriptNonce(new Headers({ [CSP_NONCE_REQUEST_HEADER]: "\"><script>" })), undefined);
});
