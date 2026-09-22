import assert from "node:assert/strict";
import test from "node:test";

import { createStorefrontPurchaseService } from "../../src/commerce/storefront-purchase.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";

function variant(overrides: Partial<StorefrontVariantFacts> = {}): StorefrontVariantFacts {
  return {
    id: "variant-available",
    pancakeVariationId: "pancake-variant-available",
    color: "Black",
    size: "M",
    sellableStock: 3,
    retailPrice: 590_000,
    retailPriceAfterDiscount: 590_000,
    ...overrides,
  };
}

test("storefront purchase authorizes only a currently purchasable mirrored variant", async () => {
  const added: Array<{ variantId: string }> = [];
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug() {
        return { variants: [variant()] };
      },
    },
    async addUnit(input: { variantId: string }) {
      added.push(input);
      return { ok: true as const, cartId: "cart-1" };
    },
  });

  const result = await service.add({ shopId: 910_050, slug: "linen-shirt", variantId: "variant-available" });

  assert.deepEqual(result, { ok: true, cartId: "cart-1" });
  assert.deepEqual(added, [{ variantId: "variant-available" }]);
});

test("storefront purchase fails closed before cart mutation for unavailable selections", async () => {
  let addCalls = 0;
  const variants = [
    variant({ id: "sold-out", size: "S", sellableStock: 0 }),
    variant({ id: "price-unresolved", size: "L", retailPriceAfterDiscount: 490_000 }),
    variant({ id: "missing-mapping", color: null, size: "XL" }),
    variant({ id: "duplicate-a", color: "Navy", size: "M" }),
    variant({ id: "duplicate-b", color: "Navy", size: "M" }),
  ];
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug({ slug }) {
        return slug === "linen-shirt" ? { variants } : null;
      },
    },
    async addUnit() {
      addCalls += 1;
      return { ok: true as const, cartId: "unexpected" };
    },
  });

  for (const variantId of [
    "missing-variant",
    "sold-out",
    "price-unresolved",
    "missing-mapping",
    "duplicate-a",
    "duplicate-b",
  ]) {
    assert.deepEqual(
      await service.add({ shopId: 910_050, slug: "linen-shirt", variantId }),
      { ok: false, reason: "VARIANT_UNAVAILABLE" },
    );
  }
  assert.deepEqual(
    await service.add({ shopId: 910_050, slug: "missing-product", variantId: "sold-out" }),
    { ok: false, reason: "VARIANT_UNAVAILABLE" },
  );
  assert.equal(addCalls, 0);
});

test("storefront purchase rejects malformed public selection input without reads or writes", async () => {
  let catalogCalls = 0;
  let addCalls = 0;
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug() {
        catalogCalls += 1;
        return { variants: [variant()] };
      },
    },
    async addUnit() {
      addCalls += 1;
      return { ok: true as const, cartId: "unexpected" };
    },
  });

  for (const input of [
    { shopId: 910_050, slug: "", variantId: "variant-available" },
    { shopId: 910_050, slug: " linen-shirt ", variantId: "variant-available" },
    { shopId: 910_050, slug: "linen-shirt", variantId: "" },
    { shopId: 910_050, slug: "linen-shirt", variantId: " variant-available " },
  ]) {
    assert.deepEqual(await service.add(input), { ok: false, reason: "INVALID_SELECTION" });
  }
  assert.equal(catalogCalls, 0);
  assert.equal(addCalls, 0);
});


test("storefront purchase forwards a bounded requested quantity only after current option authorization", async () => {
  const added: Array<{ variantId: string; quantity: number }> = [];
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug() {
        return { variants: [variant()] };
      },
    },
    async addQuantity(input: { variantId: string; quantity: number }) {
      added.push(input);
      return { ok: true as const, cartId: "cart-1" };
    },
  });

  assert.deepEqual(
    await service.add({
      shopId: 910_050,
      slug: "linen-shirt",
      variantId: "variant-available",
      quantity: 3,
    }),
    { ok: true, cartId: "cart-1" },
  );
  assert.deepEqual(added, [{ variantId: "variant-available", quantity: 3 }]);

  for (const quantity of [0, -1, 1.5, 100]) {
    assert.deepEqual(
      await service.add({
        shopId: 910_050,
        slug: "linen-shirt",
        variantId: "variant-available",
        quantity,
      }),
      { ok: false, reason: "INVALID_SELECTION" },
    );
  }
});
