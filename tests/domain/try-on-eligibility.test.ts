import assert from "node:assert/strict";
import test from "node:test";

import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import {
  TRY_ON_ELIGIBLE_TOP_LEVEL_CATEGORY_KEYS,
  resolveTryOnEligibility,
} from "../../src/commerce/try-on-eligibility.ts";

const JPG = "https://content.pancake.vn/images/1/2/3/dress.jpg";
const PNG = "https://content.pancake.vn/images/1/2/3/dress.png";
const WEBP = "https://content.pancake.vn/images/1/2/3/dress.webp";

function media(primaryImageUrl: string | null, variantImageUrls: string[][] = []) {
  return resolveStorefrontProductMedia({ productName: "Váy", primaryImageUrl, variantImageUrls });
}

test("only the aoDai, setDo and vayDam trees are eligible", () => {
  assert.deepEqual([...TRY_ON_ELIGIBLE_TOP_LEVEL_CATEGORY_KEYS], ["aoDai", "setDo", "vayDam"]);
});

test("aoDai, setDo and vayDam products (parents and subcategories) are eligible with a JPEG first image", () => {
  for (const categoryKeys of [
    ["aoDai"],
    ["aoDaiTet"],
    ["aoDai", "aoDaiCuoi"],
    ["setDo"],
    ["setVay"],
    ["setQuanAo"],
    ["vayDam"],
  ]) {
    const result = resolveTryOnEligibility({ categoryKeys, media: media(JPG) });
    assert.equal(result.eligible, true, categoryKeys.join(","));
    if (result.eligible) assert.equal(result.productImage.url, JPG);
  }
});

test("a PNG first image is eligible", () => {
  const result = resolveTryOnEligibility({ categoryKeys: ["vayDam"], media: media(PNG) });
  assert.equal(result.eligible, true);
});

test("phuKien is excluded", () => {
  assert.deepEqual(resolveTryOnEligibility({ categoryKeys: ["phuKien"], media: media(JPG) }), {
    eligible: false,
    reason: "CATEGORY_NOT_ELIGIBLE",
  });
});

test("missing or unknown category membership is excluded", () => {
  for (const categoryKeys of [[], ["notACategory"], ["vayDam", "notACategory"]]) {
    assert.deepEqual(resolveTryOnEligibility({ categoryKeys, media: media(JPG) }), {
      eligible: false,
      reason: "CATEGORY_NOT_ELIGIBLE",
    });
  }
});

test("a product spanning an eligible and an excluded tree is excluded (fail closed)", () => {
  assert.equal(
    resolveTryOnEligibility({ categoryKeys: ["vayDam", "phuKien"], media: media(JPG) }).eligible,
    false,
  );
});

test("no trusted first image is excluded", () => {
  assert.deepEqual(resolveTryOnEligibility({ categoryKeys: ["vayDam"], media: media(null) }), {
    eligible: false,
    reason: "NO_TRUSTED_IMAGE",
  });
  assert.deepEqual(
    resolveTryOnEligibility({
      categoryKeys: ["vayDam"],
      media: media("https://evil.example/a.jpg"),
    }),
    { eligible: false, reason: "NO_TRUSTED_IMAGE" },
  );
});

test("a WebP first image is excluded and image 2 is never substituted", () => {
  const result = resolveTryOnEligibility({
    categoryKeys: ["vayDam"],
    media: media(WEBP, [[JPG]]),
  });
  assert.deepEqual(result, { eligible: false, reason: "UNSUPPORTED_IMAGE_FORMAT" });
});

test("the eligible image is exactly the media authority's primary image", () => {
  const resolved = media(JPG, [[PNG]]);
  const result = resolveTryOnEligibility({ categoryKeys: ["setDo"], media: resolved });
  assert.equal(result.eligible, true);
  if (result.eligible) assert.equal(result.productImage, resolved.primary);
});
