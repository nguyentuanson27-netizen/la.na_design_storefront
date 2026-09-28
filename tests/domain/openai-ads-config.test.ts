import assert from "node:assert/strict";
import test from "node:test";

import {
  readOpenAiAdsConversionsConfig,
  readOpenAiAdsPixelConfig,
} from "../../src/integrations/openai-ads/config.ts";

test("ChatGPT Ads tracking stays off until a Pixel ID is configured", () => {
  assert.equal(readOpenAiAdsPixelConfig({}), null);
  assert.equal(readOpenAiAdsPixelConfig({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "" }), null);
  assert.equal(readOpenAiAdsConversionsConfig({ OPENAI_CONVERSIONS_API_KEY: "secret" }), null);
});

test("the Pixel ID is bounded and rejects paste whitespace", () => {
  assert.deepEqual(
    readOpenAiAdsPixelConfig({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "13453455584676424" }),
    { pixelId: "13453455584676424" },
  );
  assert.deepEqual(
    readOpenAiAdsPixelConfig({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "pixel_abc-123" }),
    { pixelId: "pixel_abc-123" },
  );

  for (const value of [" pixel_abc", "pixel abc", "x".repeat(129), "!bad"]) {
    assert.throws(
      () => readOpenAiAdsPixelConfig({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: value }),
      RangeError,
    );
  }
});

test("CAPI requires both the Pixel ID and a server-only key", () => {
  assert.equal(
    readOpenAiAdsConversionsConfig({ NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "pixel_abc" }),
    null,
  );

  assert.deepEqual(
    readOpenAiAdsConversionsConfig({
      NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "pixel_abc",
      OPENAI_CONVERSIONS_API_KEY: "secret-key",
    }),
    { pixelId: "pixel_abc", apiKey: "secret-key" },
  );

  assert.throws(
    () =>
      readOpenAiAdsConversionsConfig({
        NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: "pixel_abc",
        OPENAI_CONVERSIONS_API_KEY: " secret-key",
      }),
    RangeError,
  );
});
