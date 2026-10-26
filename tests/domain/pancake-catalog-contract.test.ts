import assert from "node:assert/strict";
import test from "node:test";

import {
  PancakeCatalogContractError,
  parsePancakeCatalogVariations,
  parsePancakeWarehouses,
} from "../../src/integrations/pancake/catalog-contract.ts";
import {
  assertReviewedPancakeContractKeysConfigured,
  REVIEWED_PANCAKE_CONTRACT_KEYS,
} from "../../src/integrations/pancake/reviewed-contract-keys.ts";

const productVariationsPayload = {
  success: true,
  page_number: 1,
  page_size: 100,
  total_entries: 1,
  total_pages: 1,
  data: [
    {
      id: "variation-1",
      product_id: "product-1",
      display_id: "DISPLAY-1",
      barcode: "BAR-1",
      fields: [
        { id: "field-color", keyValue: "color", name: "Color", value: "Black" },
        { id: "field-size", keyValue: "size", name: "Size", value: "M" },
      ],
      images: ["https://example.test/product-1.jpg"],
      is_hidden: false,
      is_locked: false,
      retail_price: 500_000,
      retail_price_after_discount: 450_000,
      product: {
        id: "product-1",
        name: "Test Shirt",
        note_product: "Approved source description",
        image: "https://example.test/product-primary.jpg",
        note: "PRIVATE INTERNAL NOTE",
      },
      variations_warehouses: [
        { warehouse_id: "warehouse-a", remain_quantity: 3 },
        { warehouse_id: "warehouse-b", remain_quantity: 4 },
      ],
      ignored_external_field: "must-not-cross-the-adapter",
    },
  ],
};

const warehousesPayload = {
  success: true,
  data: [
    {
      id: "warehouse-a",
      name: "Warehouse A",
      allow_create_order: true,
      address: null,
    },
  ],
};

function assertContractReason(run: () => unknown, expectedReason: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PancakeCatalogContractError);
    assert.equal(Reflect.get(error, "reason"), expectedReason);
    return true;
  });
}

test("catalog contract maps reviewed storefront fields, pagination, and all-warehouse sellable stock", () => {
  const result = parsePancakeCatalogVariations(productVariationsPayload);

  assert.deepEqual(result, {
    pageNumber: 1,
    pageSize: 100,
    totalEntries: 1,
    totalPages: 1,
    variations: [
      {
        id: "variation-1",
        productId: "product-1",
        displayId: "DISPLAY-1",
        barcode: "BAR-1",
        fields: [
          { id: "field-color", keyValue: "color", name: "Color", value: "Black" },
          { id: "field-size", keyValue: "size", name: "Size", value: "M" },
        ],
        imageUrls: ["https://example.test/product-1.jpg"],
        videoEvidence: { kind: "UNKNOWN", reason: "missing" },
        isHidden: false,
        isLocked: false,
        retailPrice: 500_000,
        retailPriceAfterDiscount: 450_000,
        product: {
          id: "product-1",
          name: "Test Shirt",
          sourceDescription: "Approved source description",
          primaryImageUrl: "https://example.test/product-primary.jpg",
        },
        warehouseStocks: [
          { warehouseId: "warehouse-a", remainQuantity: 3 },
          { warehouseId: "warehouse-b", remainQuantity: 4 },
        ],
        sellableStock: 7,
      },
    ],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("ignored_external_field"), false);
  assert.equal(serialized.includes("PRIVATE INTERNAL NOTE"), false);
});

test("catalog contract normalizes missing optional product source content and media to null", () => {
  const missing = structuredClone(productVariationsPayload);
  missing.data[0]!.product.note_product = null as unknown as string;
  missing.data[0]!.product.image = null as unknown as string;

  const parsedMissing = parsePancakeCatalogVariations(missing);
  assert.equal(parsedMissing.variations[0]!.product.sourceDescription, null);
  assert.equal(parsedMissing.variations[0]!.product.primaryImageUrl, null);

  const blank = structuredClone(productVariationsPayload);
  blank.data[0]!.product.note_product = "   ";
  blank.data[0]!.product.image = "";

  const parsedBlank = parsePancakeCatalogVariations(blank);
  assert.equal(parsedBlank.variations[0]!.product.sourceDescription, null);
  assert.equal(parsedBlank.variations[0]!.product.primaryImageUrl, null);
});

test("catalog contract fails closed on malformed product source content and primary image", () => {
  const malformedDescription = structuredClone(productVariationsPayload);
  malformedDescription.data[0]!.product.note_product = 123 as unknown as string;
  assertContractReason(
    () => parsePancakeCatalogVariations(malformedDescription),
    "variation-product-description",
  );

  const oversizedDescription = structuredClone(productVariationsPayload);
  oversizedDescription.data[0]!.product.note_product = "x".repeat(100_001);
  assertContractReason(
    () => parsePancakeCatalogVariations(oversizedDescription),
    "variation-product-description",
  );

  const malformedImage = structuredClone(productVariationsPayload);
  malformedImage.data[0]!.product.image = [] as unknown as string;
  assertContractReason(() => parsePancakeCatalogVariations(malformedImage), "variation-product-image");

  const oversizedImage = structuredClone(productVariationsPayload);
  oversizedImage.data[0]!.product.image = `https://example.test/${"x".repeat(4_100)}`;
  assertContractReason(() => parsePancakeCatalogVariations(oversizedImage), "variation-product-image");
});

test("catalog contract rejects malformed pagination needed for bounded full-catalog sync", () => {
  const malformed = structuredClone(productVariationsPayload);
  malformed.total_pages = Number.NaN;

  assert.throws(() => parsePancakeCatalogVariations(malformed), /pagination/i);
});

test("catalog contract fails closed on malformed sellable quantity instead of coercing it", () => {
  const malformed = structuredClone(productVariationsPayload);
  malformed.data[0]!.variations_warehouses[0]!.remain_quantity = "3" as unknown as number;

  assert.throws(() => parsePancakeCatalogVariations(malformed), PancakeCatalogContractError);
});

test("catalog contract rejects duplicate warehouse rows before aggregation", () => {
  const duplicate = structuredClone(productVariationsPayload);
  duplicate.data[0]!.variations_warehouses.push({
    warehouse_id: "warehouse-a",
    remain_quantity: 1,
  });

  assert.throws(() => parsePancakeCatalogVariations(duplicate), /duplicate warehouse/i);
});

test("catalog contract exposes only fixed safe reason codes for product validation boundaries", () => {
  const malformedPagination = structuredClone(productVariationsPayload);
  malformedPagination.total_pages = Number.NaN;
  assertContractReason(() => parsePancakeCatalogVariations(malformedPagination), "pagination");

  const malformedIdentity = structuredClone(productVariationsPayload);
  malformedIdentity.data[0]!.barcode = 123 as unknown as string;
  assertContractReason(() => parsePancakeCatalogVariations(malformedIdentity), "variation-identity");

  const malformedFields = structuredClone(productVariationsPayload);
  malformedFields.data[0]!.fields[0]!.value = null as unknown as string;
  assertContractReason(() => parsePancakeCatalogVariations(malformedFields), "variation-fields");

  const malformedImages = structuredClone(productVariationsPayload);
  malformedImages.data[0]!.images[0] = 123 as unknown as string;
  assertContractReason(() => parsePancakeCatalogVariations(malformedImages), "variation-images");

  const malformedFlags = structuredClone(productVariationsPayload);
  malformedFlags.data[0]!.is_hidden = null as unknown as boolean;
  assertContractReason(() => parsePancakeCatalogVariations(malformedFlags), "variation-flags");

  const malformedPrices = structuredClone(productVariationsPayload);
  malformedPrices.data[0]!.retail_price_after_discount = null as unknown as number;
  assertContractReason(() => parsePancakeCatalogVariations(malformedPrices), "variation-prices");

  const malformedWarehouse = structuredClone(productVariationsPayload);
  malformedWarehouse.data[0]!.variations_warehouses[0]!.remain_quantity = null as unknown as number;
  assertContractReason(() => parsePancakeCatalogVariations(malformedWarehouse), "variation-warehouse");
});

test("catalog contract consumes top-level product_id as canonical identity and ignores nested product.id", () => {
  const nestedIdIsNotAString = structuredClone(productVariationsPayload);
  nestedIdIsNotAString.data[0]!.product.id = null as unknown as string;

  const parsed = parsePancakeCatalogVariations(nestedIdIsNotAString);
  assert.equal(parsed.variations[0]!.productId, "product-1");
  assert.deepEqual(parsed.variations[0]!.product, {
    id: "product-1",
    name: "Test Shirt",
    sourceDescription: "Approved source description",
    primaryImageUrl: "https://example.test/product-primary.jpg",
  });

  const nestedIdDisagrees = structuredClone(productVariationsPayload);
  nestedIdDisagrees.data[0]!.product.id = "different-product";
  assert.equal(parsePancakeCatalogVariations(nestedIdDisagrees).variations[0]!.productId, "product-1");
});

test("catalog contract safely localizes nested product shape and name failures", () => {
  const malformedShape = structuredClone(productVariationsPayload);
  malformedShape.data[0]!.product = null as unknown as typeof productVariationsPayload.data[0]["product"];
  assertContractReason(() => parsePancakeCatalogVariations(malformedShape), "variation-product-shape");

  const malformedName = structuredClone(productVariationsPayload);
  malformedName.data[0]!.product.name = null as unknown as string;
  assertContractReason(() => parsePancakeCatalogVariations(malformedName), "variation-product-name");
});

test("catalog contract validates the minimal warehouse identity surface", () => {
  assert.deepEqual(parsePancakeWarehouses(warehousesPayload), [
    { id: "warehouse-a", name: "Warehouse A", allowCreateOrder: true },
  ]);
});

test("reviewed Pancake allowlists are configured with the live-discovered catalog keys", () => {
  assert.doesNotThrow(() => assertReviewedPancakeContractKeysConfigured());

  for (const requiredKey of [
    "data",
    "success",
    "page_number",
    "page_size",
    "total_entries",
    "total_pages",
    "id",
    "product_id",
    "display_id",
    "barcode",
    "fields",
    "images",
    "is_hidden",
    "is_locked",
    "retail_price",
    "retail_price_after_discount",
    "product",
    "note_product",
    "image",
    "variations_warehouses",
    "warehouse_id",
    "remain_quantity",
  ]) {
    assert.equal(REVIEWED_PANCAKE_CONTRACT_KEYS.productVariations.includes(requiredKey), true);
  }

  for (const requiredKey of ["data", "success", "id", "name", "allow_create_order"]) {
    assert.equal(REVIEWED_PANCAKE_CONTRACT_KEYS.warehouses.includes(requiredKey), true);
  }
});


test("optional variation videos never block valid commerce and ignore nested product videos", () => {
  for (const videos of [null, [], ["https://content.pancake.vn/videos/2026/10/26/a.mp4"], "wrong", [null], Array(9).fill("bad")]) {
    const payload = structuredClone(productVariationsPayload);
    Object.assign(payload.data[0]!, { videos });
    const parsed = parsePancakeCatalogVariations(payload).variations[0]!;
    assert.equal(parsed.retailPrice, 500_000);
    assert.equal(parsed.sellableStock, 7);
    assert.ok(parsed.videoEvidence);
  }
  const payload = structuredClone(productVariationsPayload);
  Object.assign(payload.data[0]!.product, { videos: ["https://content.pancake.vn/videos/2026/10/26/a.mp4"] });
  assert.deepEqual(parsePancakeCatalogVariations(payload).variations[0]!.videoEvidence, { kind: "UNKNOWN", reason: "missing" });
});
