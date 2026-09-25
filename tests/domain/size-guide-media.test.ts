import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSizeGuideMediaInput,
  SizeGuideMediaError,
} from "../../src/commerce/size-guide-media.ts";

const PANCAKE_URL = "https://content.pancake.vn/2-2609/2026/9/24/bang-size-ao-dai.webp";

test("size-guide artwork accepts a reviewed Pancake image for an approved guide", () => {
  assert.deepEqual(parseSizeGuideMediaInput({ guideId: "ao-dai", imageUrl: ` ${PANCAKE_URL} ` }), {
    guideId: "ao-dai",
    imageUrl: PANCAKE_URL,
  });
});

test("an empty size-guide artwork link clears the image", () => {
  for (const imageUrl of ["", "   ", null, undefined]) {
    assert.deepEqual(parseSizeGuideMediaInput({ guideId: "set-vay-form-nho", imageUrl }), {
      guideId: "set-vay-form-nho",
      imageUrl: null,
    });
  }
});

test("size-guide artwork refuses untrusted links rather than silently clearing them", () => {
  for (const imageUrl of [
    "https://example.com/2-2609/2026/9/24/bang-size.webp",
    "http://content.pancake.vn/2-2609/2026/9/24/bang-size.webp",
    "https://content.pancake.vn/2-2609/2026/9/24/bang-size.gif",
    "not a url",
  ]) {
    assert.throws(
      () => parseSizeGuideMediaInput({ guideId: "ao-dai", imageUrl }),
      (error) => error instanceof SizeGuideMediaError && error.code === "size-guide-invalid-image-url",
      imageUrl,
    );
  }
});

test("size-guide artwork only attaches to an approved guide id", () => {
  for (const input of [{ guideId: "vayDam", imageUrl: PANCAKE_URL }, { imageUrl: PANCAKE_URL }, null]) {
    assert.throws(
      () => parseSizeGuideMediaInput(input),
      (error) => error instanceof SizeGuideMediaError && error.code === "size-guide-unknown",
    );
  }
});
