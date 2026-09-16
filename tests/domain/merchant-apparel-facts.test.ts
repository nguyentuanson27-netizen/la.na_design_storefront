/**
 * U25 / #153 M3 — ADR 0007 effective apparel facts.
 *
 * The contract under test is `explicit product override -> approved shop default -> fail closed`,
 * with the three facts independent of one another and nothing ever inferred from catalog text.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MERCHANT_AGE_GROUPS,
  MERCHANT_CONDITIONS,
  MERCHANT_GENDERS,
  MERCHANT_SHOP_APPAREL_DEFAULTS,
  parseMerchantApparelOverrides,
  resolveEffectiveApparelFacts,
  toMerchantApparelWireValues,
  toPersistedMerchantApparelNames,
  type MerchantApparelOverrides,
} from "../../src/commerce/merchant-apparel-facts.ts";

function overrides(patch: Partial<MerchantApparelOverrides> = {}): MerchantApparelOverrides {
  return { gender: null, ageGroup: null, condition: null, ...patch };
}

test("M3 the reviewed Merchant enums are exactly the ADR 0007 controlled values", () => {
  assert.deepEqual([...MERCHANT_GENDERS], ["male", "female", "unisex"]);
  assert.deepEqual([...MERCHANT_AGE_GROUPS], ["newborn", "infant", "toddler", "kids", "adult"]);
  assert.deepEqual([...MERCHANT_CONDITIONS], ["new", "refurbished", "used"]);
});

test("M3 the approved shop defaults are the ADR 0007 owner decision", () => {
  // A3 replaced the template's inherited menswear default with La.na Design's approved category.
  assert.deepEqual(MERCHANT_SHOP_APPAREL_DEFAULTS, {
    gender: "female",
    ageGroup: "adult",
    condition: "new",
  });
});

test("M3 a product with no override inherits every approved shop default", () => {
  assert.deepEqual(resolveEffectiveApparelFacts(overrides()), {
    ok: true,
    facts: { gender: "female", ageGroup: "adult", condition: "new" },
    inherited: { gender: true, ageGroup: true, condition: true },
  });
});

test("M3 each apparel fact overrides independently and leaves the others inherited", () => {
  assert.deepEqual(resolveEffectiveApparelFacts(overrides({ gender: "unisex" })), {
    ok: true,
    facts: { gender: "unisex", ageGroup: "adult", condition: "new" },
    inherited: { gender: false, ageGroup: true, condition: true },
  });

  assert.deepEqual(resolveEffectiveApparelFacts(overrides({ ageGroup: "kids" })), {
    ok: true,
    facts: { gender: "female", ageGroup: "kids", condition: "new" },
    inherited: { gender: true, ageGroup: false, condition: true },
  });

  assert.deepEqual(resolveEffectiveApparelFacts(overrides({ condition: "used" })), {
    ok: true,
    facts: { gender: "female", ageGroup: "adult", condition: "used" },
    inherited: { gender: true, ageGroup: true, condition: false },
  });
});

test("M3 mixed independent overrides resolve together without touching the third fact", () => {
  assert.deepEqual(
    resolveEffectiveApparelFacts(overrides({ gender: "male", ageGroup: "kids" })),
    {
      ok: true,
      facts: { gender: "male", ageGroup: "kids", condition: "new" },
      inherited: { gender: false, ageGroup: false, condition: true },
    },
  );
});

test("M3 clearing an override returns the product to inheritance rather than a stored default copy", () => {
  const cleared = parseMerchantApparelOverrides({
    gender: "USE_SHOP_DEFAULT",
    ageGroup: "USE_SHOP_DEFAULT",
    condition: "USE_SHOP_DEFAULT",
  });

  assert.deepEqual(cleared, { ok: true, overrides: overrides() });

  const resolved = resolveEffectiveApparelFacts(overrides());
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.ok ? resolved.facts : null, {
    gender: "female",
    ageGroup: "adult",
    condition: "new",
  });
});

test("M3 admin submissions are validated server-side against the reviewed allowlist", () => {
  assert.deepEqual(
    parseMerchantApparelOverrides({ gender: "unisex", ageGroup: "kids", condition: "used" }),
    { ok: true, overrides: { gender: "unisex", ageGroup: "kids", condition: "used" } },
  );

  const rejectedPatches: readonly Record<string, unknown>[] = [
    { gender: "nam" },
    { gender: "MALE" },
    { gender: " male " },
    { gender: "male " },
    { ageGroup: "senior" },
    { ageGroup: "adult " },
    { condition: "brand-new" },
    { gender: 1 },
    { gender: ["male"] },
    { gender: {} },
    { gender: "" },
    { gender: null },
  ];

  for (const patch of rejectedPatches) {
    assert.deepEqual(
      parseMerchantApparelOverrides({
        gender: "USE_SHOP_DEFAULT",
        ageGroup: "USE_SHOP_DEFAULT",
        condition: "USE_SHOP_DEFAULT",
        ...patch,
      }),
      { ok: false, reason: "INVALID_APPAREL_OVERRIDE" },
      `expected ${JSON.stringify(patch)} to be rejected`,
    );
  }
});

test("M3 an absent submitted field is not silently treated as an instruction to clear", () => {
  assert.deepEqual(parseMerchantApparelOverrides({}), {
    ok: false,
    reason: "INVALID_APPAREL_OVERRIDE",
  });
  assert.deepEqual(parseMerchantApparelOverrides(null), {
    ok: false,
    reason: "INVALID_APPAREL_OVERRIDE",
  });
  assert.deepEqual(parseMerchantApparelOverrides("male"), {
    ok: false,
    reason: "INVALID_APPAREL_OVERRIDE",
  });
});

test("M3 a malformed persisted override fails closed instead of falling back to the shop default", () => {
  assert.deepEqual(
    resolveEffectiveApparelFacts({
      gender: "nam",
      ageGroup: null,
      condition: null,
    } as unknown as MerchantApparelOverrides),
    { ok: false, reason: "APPAREL_FACT_UNRESOLVED", fields: ["gender"] },
  );

  assert.deepEqual(
    resolveEffectiveApparelFacts({
      gender: 1,
      ageGroup: "senior",
      condition: "brand-new",
    } as unknown as MerchantApparelOverrides),
    { ok: false, reason: "APPAREL_FACT_UNRESOLVED", fields: ["gender", "ageGroup", "condition"] },
  );

  assert.deepEqual(
    resolveEffectiveApparelFacts(null as unknown as MerchantApparelOverrides),
    { ok: false, reason: "APPAREL_FACT_UNRESOLVED", fields: ["gender", "ageGroup", "condition"] },
  );
});

test("M3 the resolver cannot infer a fact from product text, category, size or model output", () => {
  // A product named for one audience is not an authorization boundary for that audience's value.
  // The resolver is handed overrides and nothing else, so extra catalog fields change no answer.
  const resolver = resolveEffectiveApparelFacts as (input: unknown) => unknown;

  assert.deepEqual(
    resolver({
      gender: null,
      ageGroup: null,
      condition: null,
      name: "Ao nu",
      category: "kids",
      description: "refurbished",
      size: "XXL",
    }),
    {
      ok: true,
      facts: { gender: "female", ageGroup: "adult", condition: "new" },
      inherited: { gender: true, ageGroup: true, condition: true },
    },
  );
});

test("M3 database enum names map to the Merchant wire values in one place", () => {
  assert.deepEqual(
    toMerchantApparelWireValues({ gender: "UNISEX", ageGroup: "KIDS", condition: "USED" }),
    { gender: "unisex", ageGroup: "kids", condition: "used" },
  );
  assert.deepEqual(toMerchantApparelWireValues({ gender: null, ageGroup: null, condition: null }), {
    gender: null,
    ageGroup: null,
    condition: null,
  });
  // An unrecognised persisted name is carried through unchanged, so the resolver — not this
  // translation — stays the single place that decides a malformed value fails closed.
  assert.deepEqual(
    toMerchantApparelWireValues({ gender: "ROBOT", ageGroup: null, condition: null }),
    { gender: "ROBOT", ageGroup: null, condition: null },
  );
});

test("M3 validated wire values map back to the persisted enum names for storage", () => {
  assert.deepEqual(
    toPersistedMerchantApparelNames({ gender: "unisex", ageGroup: "kids", condition: "used" }),
    { gender: "UNISEX", ageGroup: "KIDS", condition: "USED" },
  );
  assert.deepEqual(
    toPersistedMerchantApparelNames({ gender: null, ageGroup: null, condition: null }),
    { gender: null, ageGroup: null, condition: null },
  );
  assert.deepEqual(
    toMerchantApparelWireValues(
      toPersistedMerchantApparelNames({ gender: "female", ageGroup: "infant", condition: "new" }),
    ),
    { gender: "female", ageGroup: "infant", condition: "new" },
  );
});
