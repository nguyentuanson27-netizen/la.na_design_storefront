/**
 * M2 / M3a / M3b — the admin authorization boundary for website-owned merchandising.
 *
 * ADR 0013 §4.5 makes the membership write the *only* path that can produce a membership row,
 * because it is the only place the one-top-level invariant is enforced. A boundary that can be
 * reached without an admin session, or that lets a rejected submission through, would make that
 * claim false — so every operation is checked for both here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { CategoryMembershipError } from "../../src/commerce/category-taxonomy.ts";
import { createMerchandisingAdminService } from "../../src/commerce/merchandising-admin.ts";
import { MerchandisingError } from "../../src/commerce/merchandising-input.ts";

const ADMIN = { user: { id: "user-1", role: "ADMIN" }, session: { id: "session-1" } };
const EDITOR = { user: { id: "user-2", role: "EDITOR" }, session: { id: "session-2" } };
const SHOP_ID = 920_070;

type Call = Readonly<{ operation: string; payload: unknown }>;

function createService(options: Readonly<{ reject?: Error }> = {}) {
  const calls: Call[] = [];
  const record = (operation: string) => async (payload: unknown) => {
    if (options.reject) throw options.reject;
    calls.push({ operation, payload });
    return undefined;
  };

  const service = createMerchandisingAdminService({
    shopId: SHOP_ID,
    repository: {
      replaceHomepageFeatured: record("replaceHomepageFeatured"),
      replaceCategoryMembership: record("replaceCategoryMembership"),
      replaceCategoryProductOrder: record("replaceCategoryProductOrder"),
      replaceRelatedProductOverrides: record("replaceRelatedProductOverrides"),
      saveCategoryEditorialMedia: record("saveCategoryEditorialMedia"),
    },
  });

  return { service, calls };
}

/** Every write, so a new one cannot be added without inheriting the authorization checks below. */
function everyOperation(service: ReturnType<typeof createService>["service"]) {
  return [
    (session: unknown) => service.replaceHomepageFeatured(session as never, ["p1"]),
    (session: unknown) =>
      service.replaceCategoryMembership(session as never, {
        productId: "p1",
        categoryKeys: ["aoDaiTet"],
      }),
    (session: unknown) =>
      service.replaceCategoryProductOrder(session as never, {
        categoryKey: "aoDaiTet",
        productIds: ["p1"],
      }),
    (session: unknown) =>
      service.replaceRelatedProductOverrides(session as never, {
        productId: "p1",
        relatedProductIds: ["p2"],
      }),
    (session: unknown) => service.saveCategoryEditorialMedia(session as never, { categoryKey: "aoDai" }),
  ];
}

test("M2 no merchandising write is reachable without a session", async () => {
  const { service, calls } = createService();

  for (const operation of everyOperation(service)) {
    await assert.rejects(() => operation(null), AuthorizationError);
  }
  assert.deepEqual(calls, [], "nothing may reach the repository");
});

test("M2 a signed-in non-admin cannot write merchandising", async () => {
  const { service, calls } = createService();

  for (const operation of everyOperation(service)) {
    await assert.rejects(
      () => operation(EDITOR),
      (error: unknown) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
    );
  }
  assert.deepEqual(calls, []);
});

test("M2 an admin write reaches the repository with the configured shop", async () => {
  const { service, calls } = createService();

  const result = await service.replaceHomepageFeatured(ADMIN, ["p2", "p1"]);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    { operation: "replaceHomepageFeatured", payload: { shopId: SHOP_ID, productIds: ["p2", "p1"] } },
  ]);
});

test("G4 membership requires a usable product id before anything is written", async () => {
  const { service, calls } = createService();

  for (const input of [null, {}, { productId: "" }, { productId: "  " }, { productId: 7 }]) {
    const result = await service.replaceCategoryMembership(ADMIN, input);
    assert.deepEqual(result, { ok: false, reason: "merchandising-invalid-product" });
  }
  assert.deepEqual(calls, []);
});

test("G4 a rejected membership submission is reported, not thrown at the caller", async () => {
  // The operator needs the reason. Rethrowing would surface as a 500 with no indication of which
  // rule the submission broke.
  const { service } = createService({
    reject: new CategoryMembershipError("category-membership-multiple-top-level"),
  });

  assert.deepEqual(
    await service.replaceCategoryMembership(ADMIN, {
      productId: "p1",
      categoryKeys: ["aoDaiTet", "setVay"],
    }),
    { ok: false, reason: "category-membership-multiple-top-level" },
  );
});

test("M3a a rejected merchandising submission is reported with its reason", async () => {
  const { service } = createService({ reject: new MerchandisingError("merchandising-self-reference") });

  assert.deepEqual(
    await service.replaceRelatedProductOverrides(ADMIN, {
      productId: "p1",
      relatedProductIds: ["p1"],
    }),
    { ok: false, reason: "merchandising-self-reference" },
  );
});

test("M2 an infrastructure fault keeps propagating rather than posing as a bad submission", async () => {
  // A lost connection is not a verdict on the input. Reporting it as `{ ok: false }` would tell the
  // operator to fix a submission that was never wrong, and would hide a real outage.
  const { service } = createService({ reject: new Error("connection reset") });

  await assert.rejects(
    () => service.replaceHomepageFeatured(ADMIN, ["p1"]),
    (error: unknown) => error instanceof Error && error.message === "connection reset",
  );
});
