import assert from "node:assert/strict";
import test from "node:test";

import {
  mapVariantOptions,
  resolveVariantOptionMappings,
} from "../../src/commerce/catalog-mirror-repository.ts";
import { buildStorefrontVariantOptions } from "../../src/commerce/storefront-product.ts";
import type { PancakeCatalogField } from "../../src/integrations/pancake/catalog-contract.ts";

test("mapVariantOptions preserves clothing size and color when present", () => {
  const fields: PancakeCatalogField[] = [
    { id: "1", name: "Màu", value: "Đỏ", keyValue: "DO" },
    { id: "2", name: "Size", value: "M", keyValue: "M" },
  ];

  const result = mapVariantOptions(fields);
  assert.equal(result.color, "Đỏ");
  assert.equal(result.size, "M");
});

test("mapVariantOptions keeps size as null for clothing products that have size attributes when size is missing", () => {
  const fields: PancakeCatalogField[] = [
    { id: "1", name: "Màu", value: "Đỏ", keyValue: "DO" },
  ];

  const result = mapVariantOptions(fields, {
    isPhuKien: false,
    hasProductSizeOnPancake: true,
  });
  assert.equal(result.color, "Đỏ");
  assert.equal(result.size, null);
});

test("mapVariantOptions defaults size to 'F' for products in phuKien category when size is missing on Pancake", () => {
  // Case: NÓN LÁ with color only
  const fields: PancakeCatalogField[] = [
    { id: "1", name: "Màu", value: "Đỏ", keyValue: "DO" },
  ];

  const result = mapVariantOptions(fields, {
    isPhuKien: true,
    hasProductSizeOnPancake: false,
  });
  assert.equal(result.color, "Đỏ");
  assert.equal(result.size, "F");
});

test("mapVariantOptions defaults size to 'F' for products without any size attribute on Pancake", () => {
  // Case: TÚI SV244 with no fields at all
  const fields: PancakeCatalogField[] = [];

  const result = mapVariantOptions(fields, {
    isPhuKien: false,
    hasProductSizeOnPancake: false,
  });
  assert.equal(result.color, null);
  assert.equal(result.size, "F");
});

test("mapVariantOptions respects explicitly defined size even for phuKien products", () => {
  const fields: PancakeCatalogField[] = [
    { id: "1", name: "Size", value: "L", keyValue: "L" },
  ];

  const result = mapVariantOptions(fields, {
    isPhuKien: true,
    hasProductSizeOnPancake: true,
  });
  assert.equal(result.size, "L");
});

test("mapVariantOptions does not mask conflicting size values as 'F' for phuKien products", () => {
  const fields: PancakeCatalogField[] = [
    { id: "1", name: "Size", value: "S", keyValue: "S" },
    { id: "2", name: "Kích thước", value: "L", keyValue: "L" },
  ];

  const result = mapVariantOptions(fields, {
    isPhuKien: true,
    hasProductSizeOnPancake: true,
  });
  assert.equal(result.size, null);
});

test("mapVariantOptions fails closed on an unrecognised or blank size field instead of defaulting to 'F'", () => {
  for (const fields of [
    [{ id: "1", name: "Cỡ", value: "M", keyValue: "M" }],
    [{ id: "1", name: "Size", value: "  ", keyValue: "" }],
  ] satisfies PancakeCatalogField[][]) {
    const result = mapVariantOptions(fields, { isPhuKien: true, hasProductSizeOnPancake: false });
    assert.equal(result.size, null);
  }
});

test("a product whose other variants carry unrecognised size labels is not treated as sizeless", () => {
  const mappings = resolveVariantOptionMappings(
    [
      { id: "a", productId: "p", fields: [{ id: "1", name: "Cỡ", value: "M", keyValue: "M" }] },
      { id: "b", productId: "p", fields: [] },
    ],
    new Set(),
  );
  assert.equal(mappings.get("a")?.size, null);
  assert.equal(mappings.get("b")?.size, null);
});

test("the F default is withheld when it would collide with an explicit F of the same color", () => {
  const red: PancakeCatalogField = { id: "1", name: "Màu", value: "Đỏ", keyValue: "DO" };
  const mappings = resolveVariantOptionMappings(
    [
      { id: "explicit", productId: "p", fields: [red, { id: "2", name: "Size", value: "F", keyValue: "F" }] },
      { id: "missing", productId: "p", fields: [red] },
    ],
    new Set(["p"]),
  );
  assert.equal(mappings.get("explicit")?.size, "F");
  assert.equal(mappings.get("missing")?.size, null);

  const options = buildStorefrontVariantOptions(
    ["explicit", "missing"].map((id) => ({
      id,
      pancakeVariationId: `pancake-${id}`,
      color: mappings.get(id)!.color,
      size: mappings.get(id)!.size,
      sellableStock: 3,
      retailPrice: 100_000,
      retailPriceAfterDiscount: 100_000,
    })),
  );
  assert.equal(options[0]?.purchasable, true);
  assert.equal(options[1]?.unavailableReason, "MAPPING_REQUIRED");
});

test("the F default is withheld on a case-insensitive color collision, matching storefront identity", () => {
  const mappings = resolveVariantOptionMappings(
    [
      {
        id: "explicit",
        productId: "p",
        fields: [
          { id: "1", name: "Màu", value: "Đỏ", keyValue: "DO" },
          { id: "2", name: "Size", value: "F", keyValue: "F" },
        ],
      },
      { id: "missing", productId: "p", fields: [{ id: "3", name: "Màu", value: "đỏ", keyValue: "do" }] },
    ],
    new Set(["p"]),
  );
  assert.equal(mappings.get("explicit")?.size, "F");
  assert.equal(mappings.get("missing")?.size, null);

  const options = buildStorefrontVariantOptions(
    ["explicit", "missing"].map((id) => ({
      id,
      pancakeVariationId: `pancake-${id}`,
      color: mappings.get(id)!.color,
      size: mappings.get(id)!.size,
      sellableStock: 3,
      retailPrice: 100_000,
      retailPriceAfterDiscount: 100_000,
    })),
  );
  assert.equal(options[0]?.purchasable, true);
  assert.equal(options[1]?.unavailableReason, "MAPPING_REQUIRED");
});

test("accessory variants of different colors all default to F without colliding", () => {
  const mappings = resolveVariantOptionMappings(
    ["Đỏ", "Trắng"].map((value, i) => ({
      id: `v${i}`,
      productId: "p",
      fields: [{ id: "1", name: "Màu", value, keyValue: value }],
    })),
    new Set(["p"]),
  );
  assert.equal(mappings.get("v0")?.size, "F");
  assert.equal(mappings.get("v1")?.size, "F");
});
