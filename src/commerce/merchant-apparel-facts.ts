/**
 * U25 / #153 M3 — ADR 0007 effective Merchant apparel facts.
 *
 * One resolver owns the whole O3 question: `explicit product override -> approved shop default ->
 * fail closed`. It is pure and takes overrides and nothing else, which is the structural reason it
 * cannot infer a fact from a product name, a category, a description, a size, a Pancake field or a
 * model output — none of those are in scope here, so no future reader can reach for one.
 *
 * Absence of an override means inheritance, never "unknown". That distinction is the whole point of
 * the ADR: a null column is the approved shop default, so clearing an override in admin removes the
 * value rather than copying today's default into the row, and changing a default later moves every
 * inheriting product with it.
 *
 * A persisted value that is not on the reviewed allowlist is not silently repaired by falling back
 * to the default: it means the stored state cannot be trusted, so the product's offers are excluded
 * with `APPAREL_FACT_UNRESOLVED`. The database enums make that state unreachable through ordinary
 * writes; this check is the layer that stays correct if it ever becomes reachable anyway.
 */

import { BRAND } from "../brand/brand.config.ts";

/** Google Merchant controlled values, quoted in ADR 0007 from the Merchant Center specification. */
export const MERCHANT_GENDERS = ["male", "female", "unisex"] as const;
export const MERCHANT_AGE_GROUPS = [
  "newborn",
  "infant",
  "toddler",
  "kids",
  "adult",
] as const;
export const MERCHANT_CONDITIONS = ["new", "refurbished", "used"] as const;

export type MerchantGender = (typeof MERCHANT_GENDERS)[number];
export type MerchantAgeGroup = (typeof MERCHANT_AGE_GROUPS)[number];
export type MerchantCondition = (typeof MERCHANT_CONDITIONS)[number];

/** The explicit admin state that means "inherit the shop default", distinct from an empty field. */
export const USE_SHOP_DEFAULT = "USE_SHOP_DEFAULT";

export const APPAREL_FACT_UNRESOLVED = "APPAREL_FACT_UNRESOLVED";
export const INVALID_APPAREL_OVERRIDE = "INVALID_APPAREL_OVERRIDE";

/**
 * ADR 0007 section 1 — the owner-approved shop defaults for Merchant v1.
 *
 * Gender and age group are brand facts: a menswear shop defaults to male where a womenswear shop
 * defaults to female, so they come from Brand Config. Condition is not a brand fact — every offer
 * in this catalog is new goods — so it stays here.
 *
 * Imported from `brand.config.ts` rather than the brand loader: that module holds data only, which
 * keeps this file free of a runtime cycle back through `src/brand/index.ts`.
 */
export const MERCHANT_SHOP_APPAREL_DEFAULTS = Object.freeze({
  gender: BRAND.merchant.defaultGender,
  ageGroup: BRAND.merchant.defaultAgeGroup,
  condition: "new",
}) satisfies MerchantApparelFacts;

export type MerchantApparelFacts = Readonly<{
  gender: MerchantGender;
  ageGroup: MerchantAgeGroup;
  condition: MerchantCondition;
}>;

/** `null` on a field means inherit; it never means the fact is unknown. */
export type MerchantApparelOverrides = Readonly<{
  gender: MerchantGender | null;
  ageGroup: MerchantAgeGroup | null;
  condition: MerchantCondition | null;
}>;

/**
 * Overrides as they come back from storage: strings the allowlist has not vouched for yet.
 *
 * The resolver takes this looser shape on purpose. Typing the read path as already-validated would
 * make the fail-closed branch look unreachable and invite a cast at every call site, which is how a
 * value nobody checked ends up in a feed. A validated `MerchantApparelOverrides` is assignable here,
 * so the admin path loses nothing.
 */
export type PersistedMerchantApparelOverrides = Readonly<{
  gender: string | null;
  ageGroup: string | null;
  condition: string | null;
}>;

export type MerchantApparelField = keyof MerchantApparelFacts;

/** Fixed diagnostic order, so an excluded offer reports the same reason for the same input. */
const APPAREL_FIELDS: readonly MerchantApparelField[] = ["gender", "ageGroup", "condition"];

const ALLOWED_VALUES: Readonly<Record<MerchantApparelField, readonly string[]>> = Object.freeze({
  gender: MERCHANT_GENDERS,
  ageGroup: MERCHANT_AGE_GROUPS,
  condition: MERCHANT_CONDITIONS,
});

export type EffectiveApparelFactsResult =
  | Readonly<{
      ok: true;
      facts: MerchantApparelFacts;
      /** Which facts came from the shop default, so admin can show inheritance truthfully. */
      inherited: Readonly<Record<MerchantApparelField, boolean>>;
    }>
  | Readonly<{
      ok: false;
      reason: typeof APPAREL_FACT_UNRESOLVED;
      fields: readonly MerchantApparelField[];
    }>;

function readField(overrides: unknown, field: MerchantApparelField): unknown {
  if (typeof overrides !== "object" || overrides === null) return undefined;
  return (overrides as Record<string, unknown>)[field];
}

function hasOwnField(overrides: object, field: MerchantApparelField): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, field);
}

function isAllowedValue(field: MerchantApparelField, value: unknown): value is string {
  return typeof value === "string" && ALLOWED_VALUES[field].includes(value);
}

/**
 * Resolves the three effective apparel facts for one product.
 *
 * The overrides argument is deliberately typed but treated as untrusted at runtime: it arrives from
 * the database, and a value that no longer matches the reviewed allowlist must fail closed rather
 * than be quietly replaced by the shop default.
 */
export function resolveEffectiveApparelFacts(
  overrides: PersistedMerchantApparelOverrides,
): EffectiveApparelFactsResult {
  const unresolved: MerchantApparelField[] = [];
  const facts: Record<string, string> = {};
  const inherited: Record<string, boolean> = {};

  const isObject = typeof overrides === "object" && overrides !== null;

  for (const field of APPAREL_FIELDS) {
    if (!isObject || !hasOwnField(overrides, field)) {
      unresolved.push(field);
      continue;
    }

    const value = readField(overrides, field);
    if (value === null) {
      facts[field] = MERCHANT_SHOP_APPAREL_DEFAULTS[field];
      inherited[field] = true;
      continue;
    }

    if (!isAllowedValue(field, value)) {
      unresolved.push(field);
      continue;
    }

    facts[field] = value;
    inherited[field] = false;
  }

  if (unresolved.length > 0) {
    return Object.freeze({
      ok: false as const,
      reason: APPAREL_FACT_UNRESOLVED,
      fields: Object.freeze(unresolved),
    });
  }

  return Object.freeze({
    ok: true as const,
    facts: Object.freeze(facts) as MerchantApparelFacts,
    inherited: Object.freeze(inherited) as Readonly<Record<MerchantApparelField, boolean>>,
  });
}

export type ParsedMerchantApparelOverrides =
  | Readonly<{ ok: true; overrides: MerchantApparelOverrides }>
  | Readonly<{ ok: false; reason: typeof INVALID_APPAREL_OVERRIDE }>;

/**
 * Server-authoritative validation of one admin submission.
 *
 * Every field must be present and must be either an allowlisted value or the explicit
 * `USE_SHOP_DEFAULT` sentinel. An absent field is rejected rather than read as "clear this
 * override": a form that failed to submit a control must not silently discard a merchandising
 * decision. Client-side `<select>` options are a convenience; this function is the authority.
 */
export function parseMerchantApparelOverrides(input: unknown): ParsedMerchantApparelOverrides {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Object.freeze({ ok: false as const, reason: INVALID_APPAREL_OVERRIDE });
  }

  const overrides: Record<string, string | null> = {};

  for (const field of APPAREL_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (value === USE_SHOP_DEFAULT) {
      overrides[field] = null;
      continue;
    }
    if (!isAllowedValue(field, value)) {
      return Object.freeze({ ok: false as const, reason: INVALID_APPAREL_OVERRIDE });
    }
    overrides[field] = value;
  }

  return Object.freeze({
    ok: true as const,
    overrides: Object.freeze(overrides) as MerchantApparelOverrides,
  });
}

type PersistedApparelNames = Readonly<{
  gender: Uppercase<MerchantGender> | null;
  ageGroup: Uppercase<MerchantAgeGroup> | null;
  condition: Uppercase<MerchantCondition> | null;
}>;

/**
 * The exact reviewed name pairs, in both directions.
 *
 * An explicit table rather than a case transform: lowercasing whatever the database happens to hold
 * would let some future enum name become a valid Merchant value by accident, which is precisely the
 * class of silent widening the allowlist exists to prevent.
 */
const WIRE_VALUE_BY_PERSISTED_NAME: ReadonlyMap<string, string> = new Map(
  [...MERCHANT_GENDERS, ...MERCHANT_AGE_GROUPS, ...MERCHANT_CONDITIONS].map((value) => [
    value.toUpperCase(),
    value,
  ]),
);

/**
 * Translates persisted enum names into Merchant wire values, and back.
 *
 * The database spells the reviewed values in the repository's SCREAMING_CASE enum convention while
 * Merchant spells them lowercase. Both directions live here so the mapping exists once. An
 * unrecognised name is carried through unchanged rather than nulled or coerced, which keeps
 * `resolveEffectiveApparelFacts` the single place that decides an unusable value fails closed.
 */
export function toMerchantApparelWireValues(
  persisted: PersistedMerchantApparelOverrides,
): PersistedMerchantApparelOverrides {
  const translate = (name: string | null): string | null =>
    name === null ? null : (WIRE_VALUE_BY_PERSISTED_NAME.get(name) ?? name);

  return Object.freeze({
    gender: translate(persisted.gender),
    ageGroup: translate(persisted.ageGroup),
    condition: translate(persisted.condition),
  });
}

/**
 * The storage direction, for values the allowlist has already vouched for.
 *
 * The uppercase assertion is safe precisely because the argument is the validated type: every
 * member of the three unions upper-cases to a declared database enum name.
 */
export function toPersistedMerchantApparelNames(
  overrides: MerchantApparelOverrides,
): PersistedApparelNames {
  const persist = <TValue extends string>(value: TValue | null) =>
    value === null ? null : (value.toUpperCase() as Uppercase<TValue>);

  return Object.freeze({
    gender: persist(overrides.gender),
    ageGroup: persist(overrides.ageGroup),
    condition: persist(overrides.condition),
  });
}
