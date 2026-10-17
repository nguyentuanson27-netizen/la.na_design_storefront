import assert from "node:assert/strict";
import test from "node:test";

import { createStorefrontCartPublicActions } from "../../src/commerce/storefront-cart-public-actions.ts";

const lines = [
  { variantId: "available", available: true },
  { variantId: "insufficient", available: false },
  { variantId: "unavailable", available: false },
];

const snapshot = {
  variantExternalId: "pancake-variation-1",
  productExternalId: "pancake-product-1",
  itemName: "Linen Shirt",
  unitPriceVnd: 490_000,
  color: "Navy",
  size: "M",
};

test("cart update requires an existing line and reauthorizes the requested quantity", async () => {
  const calls: Array<{ variantId: string; quantity: number }> = [];
  const authorizations: Array<{ variantId: string; quantity: number }> = [];
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity(input) {
      authorizations.push(input);
      return input.variantId !== "unavailable" && input.quantity <= 3;
    },
    async setQuantity(input) {
      calls.push(input);
      return {
        ok: true as const,
        cartId: "internal",
        item: input,
        previousQuantity: 1,
        snapshot: { unitPriceVnd: snapshot.unitPriceVnd, analyticsItem: { ...snapshot, quantity: input.quantity } },
      };
    },
    async remove() {
      throw new Error("remove should not be called");
    },
  });

  const increase = await actions.update({
    variantId: "available",
    quantity: 3,
    ignored: "browser-data",
  });
  assert.deepEqual(increase, {
    ok: true,
    transition: { previousQuantity: 1, quantity: 3 },
    analytics: { event: "add_to_cart", item: { ...snapshot, quantity: 2 } },
  });

  const decrease = await actions.update({ variantId: "insufficient", quantity: 2 });
  assert.deepEqual(decrease, {
    ok: true,
    transition: { previousQuantity: 1, quantity: 2 },
    analytics: { event: "add_to_cart", item: { ...snapshot, quantity: 1 } },
  });

  assert.deepEqual(calls, [
    { variantId: "available", quantity: 3 },
    { variantId: "insufficient", quantity: 2 },
  ]);

  assert.deepEqual(await actions.update({ variantId: "available", quantity: 4 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
  assert.deepEqual(await actions.update({ variantId: "unavailable", quantity: 2 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
  assert.deepEqual(await actions.update({ variantId: "missing", quantity: 2 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
  assert.deepEqual(authorizations, [
    { variantId: "available", quantity: 3 },
    { variantId: "insufficient", quantity: 2 },
    { variantId: "available", quantity: 4 },
    { variantId: "unavailable", quantity: 2 },
  ]);
  assert.equal(calls.length, 2);
});

test("T6 an absolute update reports the direction and size of the committed delta", async () => {
  function actionsFor(previousQuantity: number) {
    return createStorefrontCartPublicActions({
      async getLines() {
        return lines;
      },
      async canSetQuantity() {
        return true;
      },
      async setQuantity(input) {
        return {
          ok: true as const,
          item: input,
          previousQuantity,
          snapshot: { unitPriceVnd: snapshot.unitPriceVnd, analyticsItem: { ...snapshot, quantity: input.quantity } },
        };
      },
      async remove() {
        throw new Error("remove should not be called");
      },
    });
  }

  const increased = await actionsFor(2).update({ variantId: "available", quantity: 5 });
  assert.ok(increased.ok);
  assert.deepEqual(increased.analytics, {
    event: "add_to_cart",
    item: { ...snapshot, quantity: 3 },
  });

  const decreased = await actionsFor(5).update({ variantId: "available", quantity: 2 });
  assert.ok(decreased.ok);
  assert.deepEqual(decreased.analytics, {
    event: "remove_from_cart",
    item: { ...snapshot, quantity: 3 },
  });

  // An absolute update onto the quantity already committed moved nothing; a cart quantity event
  // here would report movement that never happened.
  const unchanged = await actionsFor(3).update({ variantId: "available", quantity: 3 });
  assert.deepEqual(unchanged, {
    ok: true,
    transition: { previousQuantity: 3, quantity: 3 },
  });
});

test("T6 an update refused under the mutation lock reports an unavailable line and no event", async () => {
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    // The advisory pre-check allows it; the in-transaction re-resolution does not.
    async canSetQuantity() {
      return true;
    },
    async setQuantity() {
      return { ok: false as const, reason: "VARIANT_UNAVAILABLE", internal: "do-not-expose" };
    },
    async remove() {
      throw new Error("remove should not be called");
    },
  });

  assert.deepEqual(await actions.update({ variantId: "available", quantity: 2 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
});

test("T6 a committed update with an unusable snapshot stays successful and emits nothing", async () => {
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity() {
      return true;
    },
    async setQuantity(input) {
      return { ok: true as const, item: input, previousQuantity: 1, snapshot: { unitPriceVnd: 490_000, analyticsItem: null } };
    },
    async remove() {
      throw new Error("remove should not be called");
    },
  });

  const result = await actions.update({ variantId: "available", quantity: 4 });
  assert.deepEqual(result, {
    ok: true,
    transition: { previousQuantity: 1, quantity: 4 },
    analyticsUnavailable: true,
  });
});

test("cart remove allows an existing unavailable line but not an unknown line", async () => {
  const calls: Array<{ variantId: string }> = [];
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity() {
      throw new Error("canSetQuantity should not be called");
    },
    async setQuantity() {
      throw new Error("setQuantity should not be called");
    },
    async remove(input) {
      calls.push(input);
      return {
        ok: true as const,
        internal: "do-not-expose",
        removedQuantity: 3,
        snapshot: { unitPriceVnd: snapshot.unitPriceVnd, analyticsItem: { ...snapshot, quantity: 3 } },
      };
    },
  });

  assert.deepEqual(await actions.remove({ variantId: "unavailable", ignored: "browser-data" }), {
    ok: true,
    removedQuantity: 3,
    analytics: { event: "remove_from_cart", item: { ...snapshot, quantity: 3 } },
  });
  assert.deepEqual(calls, [{ variantId: "unavailable" }]);
  assert.deepEqual(await actions.remove({ variantId: "missing" }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
  assert.equal(calls.length, 1);
});

test("T6 removing a line that was already gone reports no RemoveFromCart", async () => {
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity() {
      throw new Error("canSetQuantity should not be called");
    },
    async setQuantity() {
      throw new Error("setQuantity should not be called");
    },
    async remove() {
      return { ok: true as const, removedQuantity: 0, snapshot: null };
    },
  });

  assert.deepEqual(await actions.remove({ variantId: "available" }), {
    ok: true,
    removedQuantity: 0,
  });
});

test("T6 a committed removal with an unusable snapshot stays successful and emits nothing", async () => {
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity() {
      throw new Error("canSetQuantity should not be called");
    },
    async setQuantity() {
      throw new Error("setQuantity should not be called");
    },
    async remove() {
      return {
        ok: true as const,
        removedQuantity: 2,
        snapshot: { unitPriceVnd: 490_000, analyticsItem: { itemName: "Linen Shirt" } },
      };
    },
  });

  assert.deepEqual(await actions.remove({ variantId: "available" }), {
    ok: true,
    removedQuantity: 2,
    analyticsUnavailable: true,
  });
});

test("T6 cart mutation responses never carry cart identity, local ids or customer facts", async () => {
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return lines;
    },
    async canSetQuantity() {
      return true;
    },
    async setQuantity(input) {
      return {
        ok: true as const,
        cartId: "internal-cart-capability",
        item: { variantId: "variant-mirror-cuid", quantity: input.quantity },
        previousQuantity: 1,
        snapshot: {
          unitPriceVnd: snapshot.unitPriceVnd,
          analyticsItem: {
            ...snapshot,
            quantity: input.quantity,
            variantId: "variant-mirror-cuid",
            guestPhone: "0900000000",
            internal: "do-not-expose",
          },
        },
      };
    },
    async remove() {
      throw new Error("remove should not be called");
    },
  });

  const serialized = JSON.stringify(
    await actions.update({ variantId: "available", quantity: 4 }),
  );
  for (const forbidden of [
    "internal-cart-capability",
    "variant-mirror-cuid",
    "0900000000",
    "do-not-expose",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not cross the boundary`);
  }
});

test("cart public actions reject malformed input and normalize downstream failures", async () => {
  let lineReads = 0;
  let quantityChecks = 0;
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      lineReads += 1;
      return lines;
    },
    async canSetQuantity() {
      quantityChecks += 1;
      return true;
    },
    async setQuantity() {
      return { ok: false as const, reason: "CART_UNAVAILABLE", internal: "do-not-expose" };
    },
    async remove() {
      return { ok: false as const, reason: "CART_UNAVAILABLE", internal: "do-not-expose" };
    },
  });

  for (const input of [
    null,
    {},
    { variantId: "", quantity: 1 },
    { variantId: " available", quantity: 1 },
    { variantId: "available", quantity: 0 },
    { variantId: "available", quantity: 1.5 },
    { variantId: "available", quantity: 2_147_483_648 },
    { variantId: "available", quantity: "2" },
  ]) {
    assert.deepEqual(await actions.update(input), { ok: false, reason: "INVALID_INPUT" });
  }
  assert.equal(lineReads, 0);
  assert.equal(quantityChecks, 0);

  assert.deepEqual(await actions.update({ variantId: "available", quantity: 2 }), {
    ok: false,
    reason: "UPDATE_FAILED",
  });
  assert.deepEqual(await actions.remove({ variantId: "available" }), {
    ok: false,
    reason: "REMOVE_FAILED",
  });
});

test("a stock refusal names the largest quantity that would sell, and only a real count", async () => {
  const refusals = new Map<string, unknown>([
    ["insufficient", { allowed: false, maxQuantity: 2 }],
    ["unavailable", false],
    ["malformed", { allowed: false, maxQuantity: -1 }],
  ]);
  const actions = createStorefrontCartPublicActions({
    async getLines() {
      return [...lines, { variantId: "malformed", available: true }];
    },
    async canSetQuantity(input) {
      return refusals.get(input.variantId) as boolean | { allowed: false; maxQuantity: number };
    },
    async setQuantity() {
      throw new Error("setQuantity should not be called");
    },
    async remove() {
      throw new Error("remove should not be called");
    },
  });

  assert.deepEqual(await actions.update({ variantId: "insufficient", quantity: 3 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
    maxQuantity: 2,
  });
  assert.deepEqual(await actions.update({ variantId: "unavailable", quantity: 3 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
  assert.deepEqual(await actions.update({ variantId: "malformed", quantity: 3 }), {
    ok: false,
    reason: "LINE_UNAVAILABLE",
  });
});
