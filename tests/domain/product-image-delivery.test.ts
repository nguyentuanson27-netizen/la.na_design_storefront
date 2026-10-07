import assert from "node:assert/strict";
import test from "node:test";

import {
  PDP_IMAGE_ALLOWED_WIDTHS,
  PDP_IMAGE_MAX_BYTES,
  buildPdpImageDeliveryUrl,
  compressProductImageUnderLimit,
  parsePdpImageWidth,
} from "../../src/commerce/product-image-delivery.ts";

const TRUSTED =
  "https://content.pancake.vn/web-media-263/6c/07/3f/33/e9440d484849f70442ba7e7181f54d19a96fd8d7e57ec5c97bbac25c-w:1792-h:2400-l:143040-t:image/jpeg.jpeg";

test("PDP image delivery has a strict 3,000,000-byte ceiling", () => {
  assert.equal(PDP_IMAGE_MAX_BYTES, 3_000_000);
});

test("the loader URL stays same-origin and carries only source plus an allowlisted width", () => {
  const url = new URL(
    buildPdpImageDeliveryUrl({ src: TRUSTED, width: 1080 }),
    "https://www.lanadesign.vn",
  );
  assert.equal(url.origin, "https://www.lanadesign.vn");
  assert.equal(url.pathname, "/api/product-image");
  assert.equal(url.searchParams.get("src"), TRUSTED);
  assert.equal(url.searchParams.get("w"), "1080");
  assert.deepEqual(parsePdpImageWidth("1080"), 1080);
});

test("only the finite responsive width set is accepted", () => {
  for (const width of PDP_IMAGE_ALLOWED_WIDTHS) {
    assert.equal(parsePdpImageWidth(String(width)), width);
  }
  for (const value of [null, "", "0", "-1", "1080.5", "1234", "999999999", "abc"]) {
    assert.equal(parsePdpImageWidth(value), null);
  }
});

test("compression retries are bounded and stop as soon as the body is strictly below 3 MB", async () => {
  const attempts: Array<{ width: number; quality: number }> = [];
  const result = await compressProductImageUnderLimit({
    requestedWidth: 1920,
    encode: async (attempt) => {
      attempts.push(attempt);
      const bytes =
        attempts.length < 4 ? PDP_IMAGE_MAX_BYTES + 100 : PDP_IMAGE_MAX_BYTES - 1;
      return new Uint8Array(bytes);
    },
  });

  assert.ok(result);
  assert.equal(result.bytes.byteLength, PDP_IMAGE_MAX_BYTES - 1);
  assert.ok(attempts.length <= 8, "compression must have a fixed retry budget");
});

test("compression fails closed when every bounded attempt remains too large", async () => {
  let attempts = 0;
  const result = await compressProductImageUnderLimit({
    requestedWidth: 3840,
    encode: async () => {
      attempts += 1;
      return new Uint8Array(PDP_IMAGE_MAX_BYTES);
    },
  });

  assert.equal(result, null);
  assert.ok(attempts > 0 && attempts <= 8);
});
