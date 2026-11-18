import test from "node:test";

test("ADR 0025: the real proxy sends a foreign first visit from / to /en and leaves everyone else alone", async () => {
  await import("../../scripts/geo-redirect-http-smoke.ts");
});
