import assert from "node:assert/strict";
import test from "node:test";

import {
  PDP_IMAGE_ALLOWED_WIDTHS,
  PDP_IMAGE_ENCODING_VERSION,
  PDP_IMAGE_MAX_BYTES,
  buildPdpImageDeliveryUrl,
  compressProductImageUnderLimit,
  isContentAddressedPancakeSource,
  negotiatePdpImageFormat,
  parsePdpImageWidth,
  snapPdpImageWidth,
} from "../../src/commerce/product-image-delivery.ts";

const TRUSTED =
  "https://content.pancake.vn/web-media-263/6c/07/3f/33/e9440d484849f70442ba7e7181f54d19a96fd8d7e57ec5c97bbac25c-w:1792-h:2400-l:143040-t:image/jpeg.jpeg";

test("PDP image delivery has a strict 3,000,000-byte ceiling", () => {
  assert.equal(PDP_IMAGE_MAX_BYTES, 3_000_000);
});

test("the loader URL stays same-origin and carries only source, an allowlisted width and the version", () => {
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
  for (const value of [null, "", "0", "-1", "16", "1080.5", "1234", "999999999", "abc"]) {
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

test("any width next/image hands the loader snaps into the reviewed set instead of throwing", () => {
  // Next's development probe calls a custom loader with 400, which is not in the set.
  assert.equal(snapPdpImageWidth(400), 640);
  assert.equal(snapPdpImageWidth(16), 32);
  assert.equal(snapPdpImageWidth(1080), 1080);
  assert.equal(snapPdpImageWidth(99_999), 3840);
  assert.equal(snapPdpImageWidth(Number.NaN), 3840);
  for (const width of [1, 400, 777, 3000, 5000]) {
    assert.notEqual(parsePdpImageWidth(String(snapPdpImageWidth(width))), null);
  }
});

test("the loader URL pins the current encoding version, so an immutable answer can be superseded", () => {
  const url = new URL(buildPdpImageDeliveryUrl({ src: TRUSTED, width: 828 }), "https://www.lanadesign.vn");
  assert.equal(url.searchParams.get("v"), PDP_IMAGE_ENCODING_VERSION);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["src", "v", "w"]);
});

test("AVIF is served only to a browser that accepts it; everything else gets WebP", () => {
  // Chrome, Firefox and Safari 16+ advertise AVIF for image requests.
  assert.equal(negotiatePdpImageFormat("image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"), "avif");
  assert.equal(negotiatePdpImageFormat("image/webp,image/avif,video/*;q=0.8,image/png,*/*;q=0.5"), "avif");
  assert.equal(negotiatePdpImageFormat("Image/AVIF; q=0.9"), "avif");
  // A browser without AVIF, a refusal, a wildcard and no header at all stay on WebP.
  assert.equal(negotiatePdpImageFormat("image/webp,image/png,*/*;q=0.8"), "webp");
  assert.equal(negotiatePdpImageFormat("image/avif;q=0,image/webp"), "webp");
  assert.equal(negotiatePdpImageFormat("*/*"), "webp");
  assert.equal(negotiatePdpImageFormat(null), "webp");
});

test("only a source whose path carries its content hash counts as immutable", () => {
  assert.equal(isContentAddressedPancakeSource(TRUSTED), true);
  assert.equal(
    isContentAddressedPancakeSource("https://cdn.pancake.vn/2/2023/5/13/8bf497694fac109aa56013bfc23dbf69198b269a.jpg"),
    true,
  );
  assert.equal(isContentAddressedPancakeSource("https://content.pancake.vn/1/2/3/4/ao-oxford-back.jpg"), false);
  assert.equal(isContentAddressedPancakeSource("https://content.pancake.vn/1/2/3/4/abc123.jpg"), false);
  assert.equal(isContentAddressedPancakeSource("not a url"), false);
});

test("a photograph is first offered at WebP 75 or AVIF 50", async () => {
  for (const [format, quality] of [["webp", 75], ["avif", 50]] as const) {
    const attempts: Array<{ width: number; quality: number }> = [];
    await compressProductImageUnderLimit({
      requestedWidth: 1200,
      format,
      encode: async (attempt) => {
        attempts.push(attempt);
        return new Uint8Array(10);
      },
    });
    assert.deepEqual(attempts, [{ width: 1200, quality }], format);
  }
});
