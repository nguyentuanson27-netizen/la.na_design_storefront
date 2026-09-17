import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontVariantOptions,
  toStorefrontSelectableOptions,
} from "../../src/commerce/storefront-product.ts";

test("storefront client options omit stock and raw integration price fields", () => {
  const [fullOption] = buildStorefrontVariantOptions([
    {
      id: "variant-1",
      pancakeVariationId: "pancake-variant-1",
      color: "Black",
      size: "M",
      sellableStock: 7,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  assert.ok(fullOption);
  assert.deepEqual(toStorefrontSelectableOptions([fullOption]), [
    {
      id: "variant-1",
      pancakeVariationId: "pancake-variant-1",
      color: "Black",
      size: "M",
      price: 590_000,
      // Website-owned presentation money, not integration data: the base price is what the page
      // already shows when nothing is discounted, and the flag is a boolean.
      basePriceVnd: null,
      isDiscounted: false,
      purchasable: true,
      // Master spec §30's `Đặt trước` marker. Same class as `isDiscounted`: a boolean the page needs
      // to describe the offer truthfully, carrying no stock number and no integration price.
      isPreorderSale: false,
      unavailableReason: null,
    },
  ]);

  // The omissions are the point of this test, so they are asserted by name rather than left to
  // the shape comparison above.
  const [clientOption] = toStorefrontSelectableOptions([fullOption]);
  for (const withheld of ["sellableStock", "retailPrice", "retailPriceAfterDiscount"]) {
    assert.equal(
      Object.hasOwn(clientOption as object, withheld),
      false,
      `${withheld} must never cross to the client`,
    );
  }
});
