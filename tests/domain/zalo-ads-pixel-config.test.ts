import assert from "node:assert/strict";
import test from "node:test";

import {
  buildZaloAdsPixelScriptSrc,
  readZaloAdsPixelConfig,
  ZALO_ADS_PIXEL_SCRIPT_ORIGIN,
} from "../../src/integrations/zalo-ads/pixel-config.ts";

// A fixture, not a real account id. Zalo publishes no id format, so the fixture only exercises the
// bounded-token contract the config enforces.
const FIXTURE_PIXEL_ID = "zalo_fixture-0123456789";

test("Zalo Ads Pixel stays off until an id is configured", () => {
  assert.equal(readZaloAdsPixelConfig({}), null);
  assert.equal(readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: "" }), null);
});

test("a configured id within the bounded token contract is enabled", () => {
  assert.deepEqual(readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: FIXTURE_PIXEL_ID }), {
    pixelId: FIXTURE_PIXEL_ID,
  });
  assert.deepEqual(readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: "1234567890123456789" }), {
    pixelId: "1234567890123456789",
  });
  assert.ok(Object.isFrozen(readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: FIXTURE_PIXEL_ID })));
});

test("malformed or whitespace-damaged ids fail loudly instead of disabling tracking", () => {
  for (const value of [
    " 123456",
    "123456 ",
    "   ",
    "\t",
    "12 34",
    "x".repeat(129),
    "<script>",
    "id\";alert(1)//",
    "id'",
    "pixel.id",
  ]) {
    assert.throws(
      () => readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: value }),
      RangeError,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("a runtime-only id cannot switch the integration on behind a build-time CSP", () => {
  // The default reader is pinned to the build-time constant next.config.mjs inlines. This test
  // process ran no build, so that constant is absent, and a runtime value must not leak through.
  const previous = process.env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID;
  process.env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID = FIXTURE_PIXEL_ID;
  try {
    assert.equal(process.env.LA_BUILD_ZALO_ADS_PIXEL_ID, undefined);
    assert.equal(readZaloAdsPixelConfig(), null);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID;
    else process.env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID = previous;
  }
});

test("the loader URL is exactly the official snippet's src with the configured id", () => {
  // From Zalo Ads' "Hướng dẫn lấy mã pixel":
  //   <script async="" src="https://s.zzcdn.me/ztr/ztracker.js?id=<PIXEL_ID>"></script>
  const config = readZaloAdsPixelConfig({ NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: "7242087840828522496" });
  assert.ok(config);
  assert.equal(
    buildZaloAdsPixelScriptSrc(config),
    "https://s.zzcdn.me/ztr/ztracker.js?id=7242087840828522496",
  );
  assert.equal(ZALO_ADS_PIXEL_SCRIPT_ORIGIN, "https://s.zzcdn.me");

  // The id is the only thing the storefront sends: no page, shopper or order data in the URL.
  const src = new URL(buildZaloAdsPixelScriptSrc(config));
  assert.deepEqual([...src.searchParams.keys()], ["id"]);
});
