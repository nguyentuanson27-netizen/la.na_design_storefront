/**
 * I2 — the admin authorization boundary for selling policy.
 *
 * Two claims are worth pinning beyond "it calls the repository". First, the session check runs
 * **before** parsing: an unauthenticated caller must not learn whether their payload would have
 * been accepted, because that is a probe of the validation rules. Second, a rejected submission
 * comes back as a reason rather than throwing, while a genuine fault keeps propagating — reporting
 * a lost connection to an operator as "your submission was invalid" sends them to fix the one thing
 * that was not wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { createSellingPolicyAdminService } from "../../src/commerce/capacity-admin.ts";
import { SellingPolicyError } from "../../src/commerce/capacity-policy-input.ts";
import { DEFAULT_NEGATIVE_STOCK_LIMIT } from "../../src/commerce/capacity-policy.ts";

const ADMIN = { user: { id: "user-1", role: "ADMIN" }, session: { id: "session-1" } };
const EDITOR = { user: { id: "user-2", role: "EDITOR" }, session: { id: "session-2" } };
const SHOP_ID = 920_090;
const PRODUCT_ID = "clx0000product0001";

type Call = Readonly<{ operation: string; payload: unknown }>;

function createService(options: Readonly<{ reject?: Error }> = {}) {
  const calls: Call[] = [];
  const record =
    (operation: string) =>
    async (payload: Record<string, unknown>) => {
      if (options.reject) throw options.reject;
      calls.push({ operation, payload });
      return {
        sellingMode: "STANDARD",
        negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
        isDefault: true,
      } as const;
    };

  const service = createSellingPolicyAdminService({
    shopId: SHOP_ID,
    repository: {
      saveSellingPolicy: record("saveSellingPolicy"),
      clearSellingPolicy: record("clearSellingPolicy"),
    },
  });

  return { service, calls };
}

test("I2 no selling-policy write is reachable without an admin session", async () => {
  const { service, calls } = createService();

  for (const session of [null, undefined, EDITOR]) {
    await assert.rejects(
      () => service.saveSellingPolicy(session, { productId: PRODUCT_ID, sellingMode: "oversell" }),
      AuthorizationError,
    );
    await assert.rejects(
      () => service.clearSellingPolicy(session, { productId: PRODUCT_ID }),
      AuthorizationError,
    );
  }

  assert.deepEqual(calls, [], "a refused caller must not reach the repository");
});

test("I2 authorization is decided before the payload is parsed", async () => {
  const { service } = createService();

  // The payload below is invalid in three separate ways. A non-admin must still get FORBIDDEN, not
  // a validation reason: an error that distinguishes "bad payload" from "not allowed" lets an
  // unauthenticated caller map the validation rules.
  await assert.rejects(
    () => service.saveSellingPolicy(EDITOR, { productId: "", sellingMode: "nope", negativeStockLimit: 9 }),
    AuthorizationError,
  );
});

test("I2 an admin write reaches the repository with the shop attached and the mode translated", async () => {
  const { service, calls } = createService();

  const result = await service.saveSellingPolicy(ADMIN, {
    productId: PRODUCT_ID,
    sellingMode: "preorder",
    negativeStockLimit: -5,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      operation: "saveSellingPolicy",
      payload: {
        shopId: SHOP_ID,
        productId: PRODUCT_ID,
        sellingMode: "PREORDER",
        negativeStockLimit: -5,
      },
    },
  ]);
});

test("I2 a clear carries only the product and does not require a mode", async () => {
  const { service, calls } = createService();

  // The caller is undoing a configuration, not describing one. Requiring a mode here would make a
  // clear refusable for naming no mode, which is the one thing a clear cannot sensibly do.
  const result = await service.clearSellingPolicy(ADMIN, { productId: PRODUCT_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { operation: "clearSellingPolicy", payload: { shopId: SHOP_ID, productId: PRODUCT_ID } },
  ]);

  // A clear still needs a real product id, so a shapeless one is refused rather than silently
  // clearing nothing.
  const refused = await service.clearSellingPolicy(ADMIN, { productId: "" });
  assert.deepEqual(refused, { ok: false, reason: "selling-policy-invalid-product" });
});

test("I2 a rejected submission is a reason, and a fault is not", async () => {
  const { service, calls } = createService();

  const refused = await service.saveSellingPolicy(ADMIN, {
    productId: PRODUCT_ID,
    sellingMode: "Oversell",
  });
  assert.deepEqual(refused, { ok: false, reason: "selling-policy-unknown-mode" });
  assert.deepEqual(calls, [], "a rejected submission must not reach the repository");

  // A repository-raised SellingPolicyError is a verdict too — that is how the shop-scope and
  // composite refusals travel out.
  const restricted = createService({ reject: new SellingPolicyError("selling-policy-composite-restricted") });
  assert.deepEqual(
    await restricted.service.saveSellingPolicy(ADMIN, {
      productId: PRODUCT_ID,
      sellingMode: "oversell",
    }),
    { ok: false, reason: "selling-policy-composite-restricted" },
  );

  // Anything else is a fault and must keep propagating.
  const broken = createService({ reject: new Error("connection terminated") });
  await assert.rejects(
    () => broken.service.saveSellingPolicy(ADMIN, { productId: PRODUCT_ID, sellingMode: "oversell" }),
    /connection terminated/,
  );
});
