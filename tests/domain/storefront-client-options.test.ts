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
      // I9 — the ADR 0011 external availability. It crosses to the client deliberately: the PDP
      // needs the date to render `Dự kiến có hàng`, and Merchant/JSON-LD parity requires one
      // decision rather than a second one made here.
      //
      // Same class as the fields above. It is the published vocabulary plus a calendar day — no
      // stock number, no limit, no mirrored integration price, and nothing from a Pancake payload.
      availability: {
        published: true,
        merchant: "in_stock",
        schema: "InStock",
        availabilityDate: null,
      },
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

  // I9 — the same guard one level down. `availability` is the one nested object on a client option,
  // so it is the one place a stock number or a raw provider field could ride along unnoticed.
  assert.deepEqual(
    Object.keys(clientOption!.availability).sort(),
    ["availabilityDate", "merchant", "published", "schema"],
    "the external availability must carry the published vocabulary and nothing else",
  );
});
