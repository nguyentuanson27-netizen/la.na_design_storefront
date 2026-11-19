import assert from "node:assert/strict";
import test from "node:test";

import { resolveVariantOptionMappings } from "../../src/commerce/catalog-mirror-repository.ts";
import { buildStorefrontProductProjection } from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import {
  isInferredFreesize,
  parseStoredCatalogFields,
} from "../../src/commerce/variant-size-evidence.ts";
import type { PancakeCatalogField } from "../../src/integrations/pancake/catalog-contract.ts";

const SIZE_F: PancakeCatalogField = { id: "s", name: "Size", value: "F", keyValue: "F" };
const colour = (value: string): PancakeCatalogField => ({
  id: "c",
  name: "Màu",
  value,
  keyValue: value,
});

type SourceVariant = {
  id: string;
  productId: string;
  fields: PancakeCatalogField[];
};

/** Sync the source variants, "persist" them (size + raw fields), then read them back as the PDP does. */
function persistedFacts(source: SourceVariant[], phuKienProductIds: string[] = []) {
  const mappings = resolveVariantOptionMappings(source, new Set(phuKienProductIds));
  return source.map((variant): StorefrontVariantFacts & { productId: string } => {
    const mapping = mappings.get(variant.id)!;
    // Round-trip the fields through JSON, as the Json column does.
    const stored: unknown = JSON.parse(JSON.stringify(variant.fields));
    return {
      id: variant.id,
      productId: variant.productId,
      pancakeVariationId: `pancake-${variant.id}`,
      color: mapping.color,
      size: mapping.size,
      ...(isInferredFreesize(mapping.size, stored) ? { sizeInferred: true } : {}),
      sellableStock: 5,
      retailPrice: 200_000,
      retailPriceAfterDiscount: 200_000,
    };
  });
}

function projectComponents(facts: (StorefrontVariantFacts & { productId: string })[]) {
  const byProduct = new Map<string, StorefrontVariantFacts[]>();
  for (const { productId, ...variant } of facts) {
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), variant]);
  }
  return buildStorefrontProductProjection({
    parentVariants: [],
    hasCompositeGraph: true,
    componentGroups: [...byProduct.values()].map((variants) => ({
      label: "QUẦN LẺ",
      variants,
    })),
  });
}

function optionOf(
  projection: ReturnType<typeof projectComponents>,
  variantId: string,
) {
  return projection.options.find((option) => option.id === variantId);
}

test("two same-role products in one composite: the inferred F is withheld, the explicit F stays buyable", () => {
  const facts = persistedFacts([
    { id: "a", productId: "A", fields: [SIZE_F] },
    { id: "b", productId: "B", fields: [] },
  ]);
  assert.equal(facts.find((f) => f.id === "a")?.sizeInferred, undefined);
  assert.equal(facts.find((f) => f.id === "b")?.sizeInferred, true);

  const projection = projectComponents(facts);
  assert.equal(optionOf(projection, "a")?.purchasable, true);
  assert.equal(optionOf(projection, "b")?.purchasable, false);
  assert.equal(optionOf(projection, "b")?.unavailableReason, "MAPPING_REQUIRED");
});

test("the same holds with colours and a different letter case", () => {
  const facts = persistedFacts(
    [
      { id: "a", productId: "A", fields: [colour("Đỏ"), SIZE_F] },
      { id: "b", productId: "B", fields: [colour("đỏ")] },
    ],
    ["B"],
  );

  const projection = projectComponents(facts);
  assert.equal(optionOf(projection, "a")?.purchasable, true);
  assert.equal(optionOf(projection, "b")?.unavailableReason, "MAPPING_REQUIRED");
});

test("an inferred F that does not collide stays buyable", () => {
  const facts = persistedFacts([
    { id: "a", productId: "A", fields: [colour("Đỏ"), SIZE_F] },
    { id: "b", productId: "B", fields: [colour("Trắng")] },
  ], ["B"]);

  const projection = projectComponents(facts);
  assert.equal(optionOf(projection, "a")?.purchasable, true);
  assert.equal(optionOf(projection, "b")?.purchasable, true);
  assert.equal(optionOf(projection, "b")?.size, "F");
});

test("two inferred F options that collide both fail closed, as before the default existed", () => {
  const facts = persistedFacts([
    { id: "a", productId: "A", fields: [] },
    { id: "b", productId: "B", fields: [] },
  ]);

  const projection = projectComponents(facts);
  assert.equal(optionOf(projection, "a")?.unavailableReason, "MAPPING_REQUIRED");
  assert.equal(optionOf(projection, "b")?.unavailableReason, "MAPPING_REQUIRED");
});

test("the internal inferred flag never reaches the projected options", () => {
  const projection = projectComponents(
    persistedFacts([{ id: "b", productId: "B", fields: [] }]),
  );
  assert.equal("sizeInferred" in (optionOf(projection, "b") ?? {}), false);
});

test("isInferredFreesize treats unreadable stored fields as explicit", () => {
  assert.equal(isInferredFreesize("F", null), false);
  assert.equal(isInferredFreesize("F", "not-fields"), false);
  assert.equal(isInferredFreesize("F", [{ name: 1, value: "x" }]), false);
  assert.equal(isInferredFreesize("M", []), false);
  assert.equal(isInferredFreesize("F", []), true);
  assert.equal(isInferredFreesize("F", [{ id: "c", name: "Màu", value: "Đỏ", keyValue: "DO" }]), true);
  assert.equal(isInferredFreesize("F", [{ id: "s", name: "Cỡ", value: "F", keyValue: "F" }]), false);
  assert.deepEqual(parseStoredCatalogFields([{ name: "Size", value: "L" }]), [
    { id: "", keyValue: "", name: "Size", value: "L" },
  ]);
});
