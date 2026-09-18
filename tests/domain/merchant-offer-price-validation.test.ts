import assert from "node:assert/strict";
import test from "node:test";

import {
  mapMerchantOffers,
  type MerchantCandidateProduct,
} from "../../src/commerce/merchant-offer-mapper.ts";
import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import { fixtureAvailability } from "../fixtures/storefront-projection-option.ts";

const ORIGIN = "https://la.example.test";
const IMAGE = "https://content.pancake.vn/web-media/1/2/3/merchant-price.jpg";

function productWithPrice(price: number): MerchantCandidateProduct {
  const media = resolveStorefrontProductMedia({
    productName: "Ao so mi",
    primaryImageUrl: IMAGE,
    variantImageUrls: [[]],
  });

  return {
    pancakeProductId: "product-price",
    slug: "ao-so-mi",
    name: "Ao so mi",
    publishedDescription: "Ao so mi cotton.",
    media,
    galleryIndexByVariantId: new Map(),
    apparelOverrides: { gender: null, ageGroup: null, condition: null },
    projection: {
      mode: "standalone",
      options: [
        {
          id: "variant-price",
          pancakeVariationId: "variation-price",
          color: "Den",
          size: "M",
          price,
          basePriceVnd: price,
          isDiscounted: false,
          purchasable: true,
          isPreorderSale: false,
          unavailableReason: null,
          availability: fixtureAvailability({
            purchasable: true,
            isPreorderSale: false,
            unavailableReason: null,
          }),
          kindKey: null,
          kindLabel: null,
        },
      ],
    },
    variations: [
      {
        variantId: "variant-price",
        pancakeVariationId: "variation-price",
        pancakeDisplayId: "PRICE-M",
        isComposite: false,
        stockQuantity: 1,
      },
    ],
  };
}

test("M3 emits an ordinary physical-apparel offer only for a finite price greater than zero", () => {
  const valid = mapMerchantOffers({ products: [productWithPrice(1)], origin: ORIGIN });
  assert.equal(valid.offers.length, 1);
  assert.equal(valid.offers[0]!.priceVnd, 1);

  for (const invalidPrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = mapMerchantOffers({ products: [productWithPrice(invalidPrice)], origin: ORIGIN });
    assert.deepEqual(result.offers, [], `expected ${String(invalidPrice)} to be excluded`);
    assert.deepEqual(result.excluded[0]?.reasons, ["PRICE_UNRESOLVED"]);
  }
});
