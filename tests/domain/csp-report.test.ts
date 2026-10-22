import assert from "node:assert/strict";
import test from "node:test";

import { createCspReportLogGate, parseCspReport } from "../../src/security/csp-report.ts";

test("a report-uri envelope is reduced to directive, blocked origin, disposition and page path", () => {
  const violations = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.lanadesign.vn/checkout?phone=0901234567#x",
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/payload.js?token=secret",
      disposition: "report",
      "source-file": "https://www.googletagmanager.com/gtm.js?id=GTM-X",
      "script-sample": "alert(document.cookie)",
      "original-policy": "default-src 'self'",
    },
  });

  assert.deepEqual(violations, [
    {
      directive: "script-src-elem",
      blocked: "https://evil.example",
      disposition: "report",
      path: "/checkout",
      source: "https://www.googletagmanager.com",
    },
  ]);
});

test("inline and eval keep their keyword; older browsers' full violated-directive is cut to its name", () => {
  const [violation] = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.lanadesign.vn/",
      "violated-directive": "script-src 'self' 'unsafe-inline'",
      "blocked-uri": "inline",
      disposition: "enforce",
    },
  });
  assert.equal(violation?.directive, "script-src");
  assert.equal(violation?.blocked, "inline");
  assert.equal(violation?.disposition, "enforce");
  assert.equal(violation?.source, null);
});

test("a Reporting API batch keeps csp-violation entries only, and at most twenty", () => {
  const entry = {
    type: "csp-violation",
    body: {
      documentURL: "https://www.lanadesign.vn/shop",
      effectiveDirective: "script-src-elem",
      blockedURL: "https://cdn.example/x.js",
      disposition: "report",
    },
  };
  const batch = [entry, { type: "deprecation", body: {} }, ...Array.from({ length: 30 }, () => entry)];
  const violations = parseCspReport(batch);

  assert.equal(violations.length, 19);
  assert.deepEqual(violations[0], {
    directive: "script-src-elem",
    blocked: "https://cdn.example",
    disposition: "report",
    path: "/shop",
    source: null,
  });
});

test("anything that is not a report yields nothing, and injected text never survives", () => {
  for (const input of [null, "x", 42, {}, [], { "csp-report": "x" }, { "csp-report": { "effective-directive": "bad directive\n{\"x\":1}" } }]) {
    assert.deepEqual(parseCspReport(input), [], JSON.stringify(input));
  }

  const [violation] = parseCspReport({
    "csp-report": {
      "effective-directive": "script-src",
      "blocked-uri": "not a url\n\"injected\"",
      "document-uri": "javascript:alert(1)",
    },
  });
  assert.equal(violation?.blocked, "other");
  assert.equal(violation?.path, "unknown");
});

test("the log gate admits a bounded number per window and reports what it suppressed", () => {
  const admit = createCspReportLogGate(2, 1_000);

  assert.deepEqual(admit(0), { log: true, suppressedInPreviousWindow: 0 });
  assert.deepEqual(admit(10), { log: true, suppressedInPreviousWindow: 0 });
  assert.deepEqual(admit(20), { log: false, suppressedInPreviousWindow: 0 });
  assert.deepEqual(admit(30), { log: false, suppressedInPreviousWindow: 0 });
  assert.deepEqual(admit(1_000), { log: true, suppressedInPreviousWindow: 2 });
  assert.deepEqual(admit(1_001), { log: true, suppressedInPreviousWindow: 0 });
});
