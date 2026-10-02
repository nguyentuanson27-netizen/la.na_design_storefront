import assert from "node:assert/strict";
import test from "node:test";

import { withAdvisorySellableStock } from "../../src/commerce/capacity-advisory.ts";
import {
  buildStorefrontVariantOptions,
  type StorefrontVariantFacts,
} from "../../src/commerce/storefront-product.ts";

test("listing advisory carries component-aware flexible capacity instead of reusing ready stock", async () => {
  const client = {
    compositeComponentMirror: {
      async findMany() {
        return [{
          parentVariantId: "combo",
          quantity: 1,
          componentVariant: {
            id: "piece",
            isPresent: true,
            product: { pancakeShopId: 1, isPresent: true },
            warehouseStocks: [{ quantity: -10 }],
          },
        }];
      },
    },
    capacityReservationResource: {
      async findMany() {
        return [];
      },
    },
  };

  const variants: StorefrontVariantFacts[] = [{
    id: "combo",
    pancakeVariationId: "pancake-combo",
    color: null,
    size: "M",
    sellableStock: 99,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
  }];
  const [product] = await withAdvisorySellableStock(client as never, 1, [{
    productCapacity: { sellingMode: "OVERSELL" as const, negativeStockLimit: -10, isComposite: true },
    variants,
  }]);

  const variant = product!.variants[0]!;
  assert.equal(variant.sellableStock, 0);
  assert.deepEqual(variant.compositeCapacity, {
    readyQuantity: 0,
    reservableQuantity: 0,
    reason: "negative-limit-reached",
  });

  const option = buildStorefrontVariantOptions(
    product!.variants,
    undefined,
    product!.productCapacity,
  )[0]!;
  assert.equal(option.purchasable, false);
  assert.equal(option.unavailableReason, "OUT_OF_STOCK");
});
