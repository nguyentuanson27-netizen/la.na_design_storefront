import assert from "node:assert/strict";
import test from "node:test";

import { buildSecondaryFulfillmentTag } from "../../src/commerce/secondary-fulfillment-note.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

function live(
  id: string,
  displayId: string,
  primarySellableStock: number,
  secondarySellableStock?: number,
): PancakeCatalogVariation {
  return {
    id,
    productId: "p",
    displayId,
    barcode: "",
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 1,
    retailPriceAfterDiscount: 1,
    product: { id: "p", name: "p" },
    warehouseStocks: [],
    sellableStock: primarySellableStock + (secondarySellableStock ?? 0),
    primarySellableStock,
    ...(secondarySellableStock === undefined ? {} : { secondarySellableStock }),
  };
}

const lives = (...variations: PancakeCatalogVariation[]) => new Map(variations.map((v) => [v.id, v]));

test("no note when the primary stock covers the order", () => {
  assert.equal(buildSecondaryFulfillmentTag([{ pancakeVariationId: "a", units: 2 }], lives(live("a", "SKU-A", 3, 5))), null);
});

test("names only the shortfall that has to come from the secondary shop", () => {
  assert.equal(
    buildSecondaryFulfillmentTag([{ pancakeVariationId: "a", units: 4 }], lives(live("a", "SKU-A", 3, 5))),
    "[Xuất kho phụ: SKU SKU-A x1]",
  );
});

test("a standalone unit and a combo component needing the same article are judged together", () => {
  // primary 1 + secondary 1; the order needs 1 loose A and a combo that needs 1 A: 2 units, so 1 must
  // come from the secondary shop. Judged one resource at a time, each fits in primary and the note is lost.
  assert.equal(
    buildSecondaryFulfillmentTag(
      [
        { pancakeVariationId: "a", units: 1 },
        { pancakeVariationId: "a", units: 1 },
      ],
      lives(live("a", "SKU-A", 1, 1)),
    ),
    "[Xuất kho phụ: SKU SKU-A x1]",
  );
});

test("negative primary stock counts as none, and the secondary stock caps the quantity", () => {
  assert.equal(
    buildSecondaryFulfillmentTag([{ pancakeVariationId: "a", units: 5 }], lives(live("a", "SKU-A", -3, 2))),
    "[Xuất kho phụ: SKU SKU-A x2]",
  );
});

test("lists several articles and ignores ones without secondary stock", () => {
  assert.equal(
    buildSecondaryFulfillmentTag(
      [
        { pancakeVariationId: "a", units: 2 },
        { pancakeVariationId: "b", units: 1 },
        { pancakeVariationId: "c", units: 1 },
      ],
      lives(live("a", "SKU-A", 0, 4), live("b", "SKU-B", 0, 1), live("c", "SKU-C", 0)),
    ),
    "[Xuất kho phụ: SKU SKU-A x2, SKU SKU-B x1]",
  );
});
