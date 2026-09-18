import assert from "node:assert/strict";
import test from "node:test";

import { createStorefrontPurchaseService } from "../../src/commerce/storefront-purchase.ts";
import type { StorefrontProductProjection } from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { fixtureAvailability } from "../fixtures/storefront-projection-option.ts";

function variant(id: string, size = "M"): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock: 2,
    retailPrice: 590_000,
    retailPriceAfterDiscount: 590_000,
  };
}

const projection: StorefrontProductProjection = {
  mode: "composite",
  options: [
    {
      id: "set-m",
      pancakeVariationId: "pancake-set-m",
      color: null,
      size: "M",
      price: 590_000,
      basePriceVnd: 590_000,
      isDiscounted: false,
      purchasable: true,
      isPreorderSale: false,
      unavailableReason: null,
      availability: fixtureAvailability({
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
      }),
      kindKey: "parent",
      kindLabel: "Set",
    },
    {
      id: "shirt-m",
      pancakeVariationId: "pancake-shirt-m",
      color: null,
      size: "M",
      price: 390_000,
      basePriceVnd: 390_000,
      isDiscounted: false,
      purchasable: true,
      isPreorderSale: false,
      unavailableReason: null,
      availability: fixtureAvailability({
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
      }),
      kindKey: "component-1",
      kindLabel: "Ao A",
    },
  ],
};

test("storefront purchase authorizes a real component variant only through the parent PDP projection", async () => {
  const added: Array<{ variantId: string }> = [];
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug({ slug }) {
        return slug === "set-a"
          ? { variants: [variant("set-m")], projection }
          : null;
      },
    },
    async addUnit(input: { variantId: string }) {
      added.push(input);
      return { ok: true as const, cartId: "cart-composite" };
    },
  });

  assert.deepEqual(
    await service.add({ shopId: 910_050, slug: "set-a", variantId: "shirt-m" }),
    { ok: true, cartId: "cart-composite" },
  );
  assert.deepEqual(added, [{ variantId: "shirt-m" }]);
});

test("storefront purchase rejects a forged real variant that is not in the current parent projection", async () => {
  let addCalls = 0;
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug() {
        return { variants: [variant("set-m")], projection };
      },
    },
    async addUnit() {
      addCalls += 1;
      return { ok: true as const, cartId: "unexpected" };
    },
  });

  assert.deepEqual(
    await service.add({ shopId: 910_050, slug: "set-a", variantId: "unrelated-real-variant" }),
    { ok: false, reason: "VARIANT_UNAVAILABLE" },
  );
  assert.equal(addCalls, 0);
});
