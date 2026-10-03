import assert from "node:assert/strict";
import test from "node:test";

import { validateCatalogSnapshot } from "../../src/commerce/catalog-mirror-repository.ts";
import type {
  PancakeCatalogField,
  PancakeParsedCatalogVariation,
} from "../../src/integrations/pancake/catalog-contract.ts";

const defaultFields: PancakeCatalogField[] = [
  { id: "field-color", keyValue: "color", name: "Color", value: "Navy" },
  { id: "field-size", keyValue: "size", name: "Size", value: "L" },
];

function buildVariation({
  id,
  productId = "prod-1",
  productName = "Oxford Shirt",
  sourceDescription = "Classic Oxford cotton.",
  primaryImageUrl = "https://content.pancake.vn/images/1/2/3/oxford.jpg",
  displayId = "OX-01",
  barcode = "BAR-01",
  fields = defaultFields,
  stocks = [{ warehouseId: "wh-1", remainQuantity: 10 }],
}: {
  id: string;
  productId?: string;
  productName?: string;
  sourceDescription?: string | null;
  primaryImageUrl?: string | null;
  displayId?: string;
  barcode?: string;
  fields?: PancakeCatalogField[];
  stocks?: Array<{ warehouseId: string; remainQuantity: number }>;
}): PancakeParsedCatalogVariation {
  return {
    id,
    productId,
    displayId,
    barcode,
    fields,
    imageUrls: ["https://content.pancake.vn/images/1/2/3/variant.jpg"],
    isHidden: false,
    isLocked: false,
    retailPrice: 450_000,
    retailPriceAfterDiscount: 450_000,
    product: {
      id: productId,
      name: productName,
      sourceDescription,
      primaryImageUrl,
    },
    warehouseStocks: stocks,
    sellableStock: stocks.reduce((sum, s) => sum + s.remainQuantity, 0),
  };
}

test("validateCatalogSnapshot groups multi-variant products with consistent source content", () => {
  const variations = [
    buildVariation({
      id: "var-1",
      productId: "prod-1",
      productName: "Oxford Shirt",
      sourceDescription: "Classic Oxford cotton.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/oxford.jpg",
      displayId: "OX-01",
    }),
    buildVariation({
      id: "var-2",
      productId: "prod-1",
      productName: "Oxford Shirt",
      sourceDescription: "Classic Oxford cotton.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/oxford.jpg",
      displayId: "OX-02",
    }),
  ];

  const { productByExternalId, variationIds } = validateCatalogSnapshot(variations);

  assert.equal(productByExternalId.size, 1);
  assert.equal(variationIds.size, 2);

  const product = productByExternalId.get("prod-1");
  assert.deepEqual(product, {
    pancakeProductId: "prod-1",
    name: "Oxford Shirt",
    productCode: null,
    sourceDescription: "Classic Oxford cotton.",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/oxford.jpg",
  });
});

test("validateCatalogSnapshot mirrors the Pancake product name without its trailing product code", () => {
  const { productByExternalId } = validateCatalogSnapshot([
    buildVariation({ id: "var-1", productName: "Set váy Diệu Liên Hoa SV605", displayId: "SV605-S" }),
    buildVariation({ id: "var-2", productName: "Set váy Diệu Liên Hoa SV605", displayId: "SV605-M" }),
  ]);

  assert.equal(productByExternalId.get("prod-1")?.name, "Set váy Diệu Liên Hoa");
  assert.equal(productByExternalId.get("prod-1")?.productCode, "SV605");
});

test("validateCatalogSnapshot keeps a garment-type-only name whole but still mirrors its product code", () => {
  const { productByExternalId } = validateCatalogSnapshot([
    buildVariation({ id: "var-1", productName: "SET VÁY SV771", displayId: "SV771-S" }),
  ]);

  assert.equal(productByExternalId.get("prod-1")?.name, "SET VÁY SV771");
  assert.equal(productByExternalId.get("prod-1")?.productCode, "SV771");
});

test("validateCatalogSnapshot rejects inconsistent sourceDescription for the same product", () => {
  const variations = [
    buildVariation({
      id: "var-1",
      productId: "prod-1",
      sourceDescription: "Description One",
    }),
    buildVariation({
      id: "var-2",
      productId: "prod-1",
      sourceDescription: "Description Two",
    }),
  ];

  assert.throws(
    () => validateCatalogSnapshot(variations),
    /inconsistent product presentation/i,
  );
});

test("validateCatalogSnapshot rejects inconsistent primaryImageUrl for the same product", () => {
  const variations = [
    buildVariation({
      id: "var-1",
      productId: "prod-1",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img-a.jpg",
    }),
    buildVariation({
      id: "var-2",
      productId: "prod-1",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img-b.jpg",
    }),
  ];

  assert.throws(
    () => validateCatalogSnapshot(variations),
    /inconsistent product presentation/i,
  );
});

test("validateCatalogSnapshot groups multi-variant products with explicit null source fields", () => {
  const variations = [
    buildVariation({
      id: "var-1",
      productId: "prod-1",
      productName: "Oxford Shirt",
      sourceDescription: null,
      primaryImageUrl: null,
      displayId: "OX-01",
    }),
    buildVariation({
      id: "var-2",
      productId: "prod-1",
      productName: "Oxford Shirt",
      sourceDescription: null,
      primaryImageUrl: null,
      displayId: "OX-02",
    }),
  ];

  const { productByExternalId, variationIds } = validateCatalogSnapshot(variations);

  assert.equal(productByExternalId.size, 1);
  assert.equal(variationIds.size, 2);

  const product = productByExternalId.get("prod-1");
  assert.deepEqual(product, {
    pancakeProductId: "prod-1",
    name: "Oxford Shirt",
    productCode: null,
    sourceDescription: null,
    primaryImageUrl: null,
  });
});
