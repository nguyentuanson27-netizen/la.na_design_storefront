import assert from "node:assert/strict";
import test from "node:test";

import { mapVariantOptions } from "../../src/commerce/catalog-mirror-repository.ts";
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
