import test from "node:test";

test("ADR 0025: the real proxy redirects foreign first visits from / to /en and Vietnamese first visits from /en* to Vietnamese", async () => {
  await import("../../scripts/geo-redirect-http-smoke.ts");
});
