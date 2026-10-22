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
  const admit = createCspReportLogGate({ limit: 2, clientLimit: 5, windowMs: 1_000 });

  assert.deepEqual(admit(0, "a"), { log: true, suppressedInPreviousWindow: null });
  assert.deepEqual(admit(10, "b"), { log: true, suppressedInPreviousWindow: null });
  assert.deepEqual(admit(20, "c"), { log: false, suppressedInPreviousWindow: null });
  assert.deepEqual(admit(30, "d"), { log: false, suppressedInPreviousWindow: null });
  assert.deepEqual(admit(1_000, "a"), { log: true, suppressedInPreviousWindow: { byClient: 0, byWindow: 2 } });
  assert.deepEqual(admit(1_001, "a"), { log: true, suppressedInPreviousWindow: null });
});

test("one client flooding the endpoint cannot crowd out reports from other clients", () => {
  const admit = createCspReportLogGate({ limit: 10, clientLimit: 3, windowMs: 1_000 });

  const flood = Array.from({ length: 50 }, (_, index) => admit(index, "attacker").log);
  assert.equal(flood.filter(Boolean).length, 3);

  // Real browsers' reports still reach the log in the same window.
  for (const client of ["shopper-1", "shopper-2", "shopper-3"]) assert.equal(admit(100, client).log, true);
  // Reports with no trusted client IP share one budget rather than escaping the per-client cap.
  assert.deepEqual([admit(200, null), admit(201, null), admit(202, null), admit(203, null)].map((d) => d.log), [true, true, true, false]);

  assert.deepEqual(admit(1_000, "shopper-1").suppressedInPreviousWindow, { byClient: 48, byWindow: 0 });
});

test("past the tracked-client bound, new clients share one overflow budget", () => {
  const admit = createCspReportLogGate({ limit: 100, clientLimit: 2, windowMs: 1_000, maxTrackedClients: 3 });
  for (const client of ["a", "b", "c"]) assert.equal(admit(0, client).log, true);

  assert.deepEqual(["d", "e", "f", "g"].map((client) => admit(1, client).log), [true, true, false, false]);
});
