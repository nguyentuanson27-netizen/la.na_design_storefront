/**
 * U25 / #153 M3 — the deterministic standalone Merchant offer mapper.
 *
 * One pure function turns canonical storefront facts into Merchant items. It owns no pricing, no
 * stock semantics, no media trust boundary, no addressing contract and no apparel policy: every one
 * of those already has an authority in this repository, and the mapper's job is to consume them in
 * the right order and refuse to emit anything it cannot substantiate.
 *
 *   canonical catalog/storefront facts
 *           |
 *   effective Merchant facts   (this module)
 *           |
 *   Merchant item  |  excluded candidate + bounded reasons
 *
 * The authorities it consumes, and why each is not re-derived here:
 *
 *   - price comes from the projection option, which the caller built with the shared promotional
 *     pricing rule the storefront charges from. A feed that recomputed a discount would be the
 *     second money formula #151 exists to prevent;
 *   - availability is `classifyMerchantAvailability`, the M1 Merchant stock semantics, so feed
 *     counts reconcile with the audited M1 numbers rather than describing a different catalog;
 *   - the landing URL is built and then *proved* by U12's own resolver: the mapper asks
 *     `resolveDeepLinkedVariantSelection` whether this exact identity resolves to this exact option
 *     on this product, so an offer link can never point at a page that would not preselect it;
 *   - media is whatever the trusted storefront resolver already returned. Raw Pancake URLs never
 *     reach this module;
 *   - identity, MPN and XML text safety are the M1 classifiers, under ADR 0008 for the MPN source;
 *   - apparel facts are ADR 0007's resolver, which cannot see catalog text at all.
 *
 * Three things it will not do, and one it cannot:
 *
 *   - it will not fall back from a missing `pancakeDisplayId` to the website-owned
 *     `VariantMirror.sku`. That field is not an input;
 *   - it will not emit `gtin`. A Pancake barcode is a field name, not a proof of identifier type,
 *     format and check digit, so no barcode is an input either;
 *   - it will not invent or silently repair a description, apparel attribute, price or stock state
 *     to make a row publishable;
 *   - and the pure mapper cannot query anything. Repository reads are separately bounded and batched,
 *     so this module itself can never introduce a per-offer database lookup.
 *
 * Composite offers stay `COMPOSITE_DEFERRED` for Merchant v1, exactly as M1 audited them.
 */

import {
  classifyExternalIdentifier,
  classifyMerchantAvailability,
  classifyMerchantText,
  MERCHANT_ID_MAX_LENGTH,
  MERCHANT_MPN_MAX_LENGTH,
} from "./merchant-identity-audit.ts";
import {
  APPAREL_FACT_UNRESOLVED,
  resolveEffectiveApparelFacts,
  type MerchantAgeGroup,
  type MerchantCondition,
  type MerchantGender,
  type PersistedMerchantApparelOverrides,
} from "./merchant-apparel-facts.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import { BRAND } from "../brand/index.ts";
import type {
  StorefrontProductProjection,
  StorefrontProjectionOption,
} from "./storefront-projection.ts";
import {
  buildStandaloneVariantDeepLinkPath,
  resolveDeepLinkedVariantSelection,
} from "./storefront-variant-deep-link.ts";

/** The brand owner is the only brand in the feed; there is no per-product brand fact to resolve. */
export const MERCHANT_BRAND = BRAND.merchant.feedBrand;

/** Google Merchant accepts at most ten `additional_image_link` values per offer. */
export const MAX_MERCHANT_ADDITIONAL_IMAGES = 10;

/** Current Google Merchant attribute bounds used by the apparel-only M3 v1 contract. */
export const MERCHANT_TITLE_MAX_LENGTH = 150;
export const MERCHANT_DESCRIPTION_MAX_LENGTH = 5_000;
export const MERCHANT_COLOR_MAX_LENGTH = 100;
export const MERCHANT_SIZE_MAX_LENGTH = 100;

export const MERCHANT_MARKET_UNRESOLVED = "MERCHANT_MARKET_UNRESOLVED";

export type MerchantAvailability = "in_stock" | "out_of_stock";

export type MerchantExclusionReason =
  | "COMPOSITE_DEFERRED"
  | "OFFER_ID_UNRESOLVED"
  | "ITEM_GROUP_ID_UNRESOLVED"
  | "MPN_UNRESOLVED"
  | typeof APPAREL_FACT_UNRESOLVED
  | "OPTION_NOT_ADDRESSABLE"
  | "LANDING_URL_UNRESOLVED"
  | "PRICE_UNRESOLVED"
  | "AVAILABILITY_UNRESOLVED"
  | "MEDIA_UNRESOLVED"
  | "TITLE_UNRESOLVED"
  | "DESCRIPTION_UNRESOLVED"
  | "COLOR_UNRESOLVED"
  | "SIZE_UNRESOLVED"
  | "OFFER_ID_DUPLICATE"
  | "MPN_DUPLICATE";

/**
 * The canonical reason order.
 *
 * Diagnostics are part of the contract, not debug output: a fixed order means the same catalog
 * produces the same excluded list on every run, which is what lets an operator diff two audits and
 * see a real change rather than a reshuffle.
 */
const REASON_ORDER: readonly MerchantExclusionReason[] = [
  "COMPOSITE_DEFERRED",
  "OFFER_ID_UNRESOLVED",
  "ITEM_GROUP_ID_UNRESOLVED",
  "MPN_UNRESOLVED",
  APPAREL_FACT_UNRESOLVED,
  "OPTION_NOT_ADDRESSABLE",
  "LANDING_URL_UNRESOLVED",
  "PRICE_UNRESOLVED",
  "AVAILABILITY_UNRESOLVED",
  "MEDIA_UNRESOLVED",
  "TITLE_UNRESOLVED",
  "DESCRIPTION_UNRESOLVED",
  "COLOR_UNRESOLVED",
  "SIZE_UNRESOLVED",
  "OFFER_ID_DUPLICATE",
  "MPN_DUPLICATE",
];

export type MerchantCandidateVariation = Readonly<{
  /** Internal `VariantMirror.id`. Aligns per-variant media and nothing else; never emitted. */
  variantId: string;
  /** External Merchant offer identity. */
  pancakeVariationId: string | null;
  /** ADR 0008 manufacturer MPN candidate, mirrored from the Pancake variation `display_id`. */
  pancakeDisplayId: string | null;
  /** Parent of, or component in, a composite set. Either side is deferred in Merchant v1. */
  isComposite: boolean;
  /** Summed warehouse stock under M1 availability semantics; `NaN` when any source is unsafe. */
  stockQuantity: number;
}>;

export type MerchantCandidateProduct = Readonly<{
  /** External Merchant `item_group_id`. */
  pancakeProductId: string | null;
  slug: string;
  name: string;
  /** Only what the storefront publishes. A Draft description is not a Merchant fact. */
  publishedDescription: string | null;
  /** Output of the trusted storefront media resolver, not raw mirrored URLs. */
  media: StorefrontProductMedia;
  /** Canonical variant-to-gallery mapping, keyed by internal `VariantMirror.id`. */
  galleryIndexByVariantId: ReadonlyMap<string, number>;
  /** The projection the product page builds, priced by the shared promotional rule. */
  projection: StorefrontProductProjection;
  /**
   * ADR 0007 website-owned overrides, as stored. `null` on a field means inherit the shop default;
   * anything the allowlist does not recognise fails the whole product closed.
   */
  apparelOverrides: PersistedMerchantApparelOverrides;
  variations: readonly MerchantCandidateVariation[];
}>;

export type MerchantOffer = Readonly<{
  id: string;
  itemGroupId: string;
  brand: typeof MERCHANT_BRAND;
  mpn: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: readonly string[];
  availability: MerchantAvailability;
  /**
   * The effective storefront price in Vietnamese dong, which is the denomination the mirrored
   * catalog holds. Turning it into a Merchant `price` string with an ISO currency belongs to the
   * reviewed market declaration below, and therefore waits on owner gate O2.
   */
  priceVnd: number;
  gender: MerchantGender;
  ageGroup: MerchantAgeGroup;
  condition: MerchantCondition;
  /** Required for apparel/free-listing eligibility in this M3 v1 scope. */
  color: string;
  /** Required for apparel, so an offer is never emitted without one. */
  size: string;
}>;

/** Bounded, non-PII diagnostics: external identity and reasons, never catalog content. */
export type MerchantExcludedCandidate = Readonly<{
  pancakeVariationId: string | null;
  itemGroupId: string | null;
  reasons: readonly MerchantExclusionReason[];
}>;

export type MerchantMarketEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Owner gate O2 — target market, content language and feed currency.
 *
 * Owner decision O2 is resolved as Vietnam / Vietnamese / VND. Production commerce code reads this
 * only through the zero-argument `resolveMerchantMarket()` server boundary. The parameterized
 * `resolveMerchantMarketFromEnvironment()` exists for release validation and focused tests; request,
 * query, header, Host and business-call arguments are not market authorities.
 */
export type MerchantMarketPolicy = Readonly<{
  /** ISO 3166-1 alpha-2, uppercase. */
  targetCountry: string;
  /** ISO 639-1, lowercase. */
  contentLanguage: string;
  /** ISO 4217, uppercase. */
  currency: string;
}>;

export type MerchantMarketResolution =
  | Readonly<{ status: "APPROVED"; policy: MerchantMarketPolicy }>
  | Readonly<{ status: "UNRESOLVED"; reason: typeof MERCHANT_MARKET_UNRESOLVED }>;

/** Canonical reviewed owner-approved O2 market policy for Vietnam. */
export const APPROVED_O2_MARKET_POLICY: MerchantMarketPolicy = Object.freeze({
  targetCountry: "VN",
  contentLanguage: "vi",
  currency: "VND",
});

/** Compatibility constant for historical audit imports; runtime authority is server configuration. */
export const APPROVED_MERCHANT_MARKET: MerchantMarketPolicy | null = null;

function unresolvedMerchantMarket(): MerchantMarketResolution {
  return Object.freeze({
    status: "UNRESOLVED" as const,
    reason: MERCHANT_MARKET_UNRESOLVED,
  });
}

function parseReviewedMerchantMarket(candidate: unknown): MerchantMarketPolicy | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;

  const record = candidate as Record<string, unknown>;
  const targetCountry = record.targetCountry;
  const contentLanguage = record.contentLanguage;
  const currency = record.currency;

  if (
    typeof targetCountry !== "string"
    || !/^[A-Z]{2}$/.test(targetCountry)
    || typeof contentLanguage !== "string"
    || !/^[a-z]{2}$/.test(contentLanguage)
    || typeof currency !== "string"
    || !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }

  if (
    targetCountry !== APPROVED_O2_MARKET_POLICY.targetCountry
    || contentLanguage !== APPROVED_O2_MARKET_POLICY.contentLanguage
    || currency !== APPROVED_O2_MARKET_POLICY.currency
  ) {
    return null;
  }

  return Object.freeze({ targetCountry, contentLanguage, currency });
}

/** Pure release/test reader for the three canonical server-owned variables. */
export function resolveMerchantMarketFromEnvironment(
  env: MerchantMarketEnvironment,
): MerchantMarketResolution {
  const targetCountry = env.LA_MERCHANT_TARGET_COUNTRY;
  const contentLanguage = env.LA_MERCHANT_CONTENT_LANGUAGE;
  const currency = env.LA_MERCHANT_CURRENCY;

  if (targetCountry === undefined || contentLanguage === undefined || currency === undefined) {
    return unresolvedMerchantMarket();
  }

  const policy = parseReviewedMerchantMarket({ targetCountry, contentLanguage, currency });
  return policy === null
    ? unresolvedMerchantMarket()
    : Object.freeze({ status: "APPROVED" as const, policy });
}

/** Production runtime authority. No request or business caller can supply the market configuration. */
export function resolveMerchantMarket(): MerchantMarketResolution {
  return resolveMerchantMarketFromEnvironment(process.env);
}

export type MerchantMappingResult = Readonly<{
  offers: readonly MerchantOffer[];
  excluded: readonly MerchantExcludedCandidate[];
  market: MerchantMarketResolution;
  /** Non-empty means Merchant must not be activated from this projection. */
  activationBlockedReasons: readonly string[];
}>;

type Draft = {
  readonly pancakeVariationId: string | null;
  readonly itemGroupId: string | null;
  readonly reasons: Set<MerchantExclusionReason>;
  readonly offer: MerchantOffer | null;
};

function requireAbsoluteOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("Merchant offer origin must be an absolute http(s) origin");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Merchant offer origin must be an absolute http(s) origin");
  }
  return parsed;
}

function isMerchantIdentifier(
  value: string | null,
  maxLength: number,
  allowWhitespace: boolean,
): value is string {
  return classifyExternalIdentifier(value, { maxLength, allowWhitespace }) === "PRESENT";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Required Merchant text that is XML-safe and inside the reviewed attribute bound. */
function resolveBoundedMerchantText(value: string | null, maxLength: number): string | null {
  if (classifyMerchantText(value) !== "READY" || value === null) return null;
  return codePointLength(value) <= maxLength ? value : null;
}

/**
 * Required apparel dimension. Storefront projection normally supplies trimmed values, but M3 treats
 * its input as untrusted and refuses blank/untrimmed/malformed/overlong data rather than normalizing
 * it into a different Merchant fact.
 */
function resolveRequiredApparelAttribute(value: string | null, maxLength: number): string | null {
  if (value === null || value.length === 0 || value !== value.trim()) return null;
  return resolveBoundedMerchantText(value, maxLength);
}

/** Google Merchant rejects zero/negative prices for ordinary physical goods such as apparel. */
function resolveMerchantPrice(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The trusted image for this exact variant, then the product's canonical primary as the fallback.
 *
 * Both come out of the same resolver, so the fallback is not a relaxation of the trust boundary —
 * it is the same product-level photography the storefront shows when a variant has none of its own.
 */
function resolveOfferImages(
  product: MerchantCandidateProduct,
  variantId: string,
): { imageLink: string | null; additionalImageLinks: readonly string[] } {
  const gallery = product.media.gallery;
  const index = product.galleryIndexByVariantId.get(variantId);
  const variantImage =
    index !== undefined && Number.isInteger(index) ? (gallery[index]?.url ?? null) : null;
  const imageLink = variantImage ?? product.media.primary?.url ?? null;

  if (imageLink === null) return { imageLink: null, additionalImageLinks: [] };

  const additionalImageLinks = gallery
    .map((image) => image.url)
    .filter((url) => url !== imageLink)
    .slice(0, MAX_MERCHANT_ADDITIONAL_IMAGES);

  return { imageLink, additionalImageLinks };
}

/**
 * Proves the emitted link with the storefront's own resolver.
 *
 * Building the path is not enough: a path is only a landing page if the product page would resolve
 * that identity to that exact option. Asking U12 closes the whole hostile class at once — stale,
 * forged, another product's, deactivated, private, ambiguous and composite identities are all
 * simply absent from the authorized option list, and none of them can produce an offer URL.
 */
function resolveAddressableOption(
  product: MerchantCandidateProduct,
  variation: MerchantCandidateVariation,
  optionsByVariantId: ReadonlyMap<string, StorefrontProjectionOption>,
): StorefrontProjectionOption | null {
  if (variation.pancakeVariationId === null) return null;

  const selection = resolveDeepLinkedVariantSelection({
    projection: product.projection,
    variantQuery: variation.pancakeVariationId,
  });
  if (selection === null || selection.variantId !== variation.variantId) return null;

  const option = optionsByVariantId.get(variation.variantId);
  // The external identity must still agree with the option the internal handle names. U12 already
  // refused a duplicated identity, so this only rejects a candidate row that disagrees with the
  // projection it was loaded beside.
  return option !== undefined && option.pancakeVariationId === variation.pancakeVariationId
    ? option
    : null;
}

/**
 * Index of a product's authorized options by internal variant id.
 *
 * Built once per product rather than searched per candidate: a duplicated internal id cannot be
 * resolved to one option, so it is dropped from the index and its candidate reads as unaddressable.
 */
function indexOptionsByVariantId(
  projection: StorefrontProductProjection,
): ReadonlyMap<string, StorefrontProjectionOption> {
  const index = new Map<string, StorefrontProjectionOption>();
  const duplicated = new Set<string>();

  for (const option of projection.options) {
    if (index.has(option.id)) duplicated.add(option.id);
    else index.set(option.id, option);
  }
  for (const id of duplicated) index.delete(id);

  return index;
}

function draftCandidate(
  product: MerchantCandidateProduct,
  variation: MerchantCandidateVariation,
  optionsByVariantId: ReadonlyMap<string, StorefrontProjectionOption>,
  origin: URL,
): Draft {
  const pancakeVariationId = variation.pancakeVariationId;

  // Composite is a whole-projection verdict as well as a per-variation one: a set's parent option
  // and its components are equally deferred, and reporting one reason keeps the excluded counts
  // reconcilable with the M1 audit rather than mixing a deferral with incidental readiness gaps.
  if (variation.isComposite || product.projection.mode !== "standalone") {
    return {
      pancakeVariationId,
      itemGroupId: product.pancakeProductId,
      reasons: new Set<MerchantExclusionReason>(["COMPOSITE_DEFERRED"]),
      offer: null,
    };
  }

  const reasons = new Set<MerchantExclusionReason>();

  const hasOfferId = isMerchantIdentifier(pancakeVariationId, MERCHANT_ID_MAX_LENGTH, false);
  if (!hasOfferId) reasons.add("OFFER_ID_UNRESOLVED");

  const hasItemGroupId = isMerchantIdentifier(
    product.pancakeProductId,
    MERCHANT_ID_MAX_LENGTH,
    false,
  );
  if (!hasItemGroupId) reasons.add("ITEM_GROUP_ID_UNRESOLVED");

  const hasMpn = isMerchantIdentifier(variation.pancakeDisplayId, MERCHANT_MPN_MAX_LENGTH, true);
  if (!hasMpn) reasons.add("MPN_UNRESOLVED");

  const apparel = resolveEffectiveApparelFacts(product.apparelOverrides);
  if (!apparel.ok) reasons.add(APPAREL_FACT_UNRESOLVED);

  const addressableOption = resolveAddressableOption(product, variation, optionsByVariantId);
  if (addressableOption === null) reasons.add("OPTION_NOT_ADDRESSABLE");

  // Two reasons are reported only when they are the candidate's own fault rather than a consequence
  // of one already recorded: a landing URL cannot be blamed on a slug when the offer identity itself
  // is unusable, and a price cannot be called unresolved when no option was ever resolved to price.
  // Cascaded reasons would make every excluded row look like several independent defects.
  const path =
    hasOfferId && pancakeVariationId !== null
      ? buildStandaloneVariantDeepLinkPath({ slug: product.slug, pancakeVariationId })
      : null;
  if (hasOfferId && path === null) reasons.add("LANDING_URL_UNRESOLVED");

  const priceVnd = resolveMerchantPrice(addressableOption?.price ?? null);
  if (addressableOption !== null && priceVnd === null) reasons.add("PRICE_UNRESOLVED");

  const availabilityClass = classifyMerchantAvailability(variation.stockQuantity);
  if (availabilityClass === "AVAILABILITY_UNRESOLVED") reasons.add("AVAILABILITY_UNRESOLVED");

  const { imageLink, additionalImageLinks } = resolveOfferImages(product, variation.variantId);
  if (imageLink === null) reasons.add("MEDIA_UNRESOLVED");

  const title = resolveBoundedMerchantText(product.name, MERCHANT_TITLE_MAX_LENGTH);
  if (title === null) reasons.add("TITLE_UNRESOLVED");

  const description = resolveBoundedMerchantText(
    product.publishedDescription,
    MERCHANT_DESCRIPTION_MAX_LENGTH,
  );
  if (description === null) reasons.add("DESCRIPTION_UNRESOLVED");

  const color =
    addressableOption === null
      ? null
      : resolveRequiredApparelAttribute(addressableOption.color, MERCHANT_COLOR_MAX_LENGTH);
  if (addressableOption !== null && color === null) reasons.add("COLOR_UNRESOLVED");

  const size =
    addressableOption === null
      ? null
      : resolveRequiredApparelAttribute(addressableOption.size, MERCHANT_SIZE_MAX_LENGTH);
  if (addressableOption !== null && size === null) reasons.add("SIZE_UNRESOLVED");

  // Every condition below has already recorded its own reason, so `reasons.size` alone decides the
  // outcome. They are repeated here only so the emitted offer needs no cast to convince the type
  // checker that a fact it refused to emit without is present.
  if (
    reasons.size > 0
    || !apparel.ok
    || addressableOption === null
    || path === null
    || priceVnd === null
    || imageLink === null
    || title === null
    || description === null
    || color === null
    || size === null
    || !hasMpn
    || !hasOfferId
    || !hasItemGroupId
  ) {
    return { pancakeVariationId, itemGroupId: product.pancakeProductId, reasons, offer: null };
  }

  return {
    pancakeVariationId,
    itemGroupId: product.pancakeProductId,
    reasons,
    offer: Object.freeze({
      id: pancakeVariationId,
      itemGroupId: product.pancakeProductId,
      brand: MERCHANT_BRAND,
      mpn: variation.pancakeDisplayId,
      title,
      description,
      link: new URL(path, origin).href,
      imageLink,
      additionalImageLinks: Object.freeze(additionalImageLinks),
      availability: availabilityClass === "IN_STOCK" ? "in_stock" : "out_of_stock",
      priceVnd,
      gender: apparel.facts.gender,
      ageGroup: apparel.facts.ageGroup,
      condition: apparel.facts.condition,
      color,
      size,
    }),
  };
}

/** Values claimed by more than one otherwise-emittable draft. */
function duplicatesAmong(values: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    else seen.add(value);
  }
  return duplicated;
}

export function mapMerchantOffers({
  products,
  origin,
}: Readonly<{
  products: readonly MerchantCandidateProduct[];
  /** Absolute storefront origin, from `readStorefrontOrigin`. */
  origin: string;
}>): MerchantMappingResult {
  const parsedOrigin = requireAbsoluteOrigin(origin);

  const drafts: Draft[] = [];
  for (const product of products) {
    const optionsByVariantId = indexOptionsByVariantId(product.projection);
    for (const variation of product.variations) {
      drafts.push(draftCandidate(product, variation, optionsByVariantId, parsedOrigin));
    }
  }

  // Uniqueness is a property of the emittable set, so it is decided after every candidate has been
  // judged on its own facts. A duplicate is never resolved by preferring one claimant: both are
  // excluded, because the catalog cannot say which offer the identity or the part number names.
  const emittable = drafts.filter((draft) => draft.offer !== null);
  const duplicateIds = duplicatesAmong(emittable.map((draft) => draft.offer!.id));
  const duplicateMpns = duplicatesAmong(emittable.map((draft) => draft.offer!.mpn));

  const offers: MerchantOffer[] = [];
  const excluded: MerchantExcludedCandidate[] = [];

  for (const draft of drafts) {
    const reasons = draft.reasons;
    if (draft.offer !== null) {
      if (duplicateIds.has(draft.offer.id)) reasons.add("OFFER_ID_DUPLICATE");
      if (duplicateMpns.has(draft.offer.mpn)) reasons.add("MPN_DUPLICATE");
    }

    if (reasons.size === 0 && draft.offer !== null) {
      offers.push(draft.offer);
      continue;
    }

    excluded.push(
      Object.freeze({
        pancakeVariationId: draft.pancakeVariationId,
        itemGroupId: draft.itemGroupId,
        reasons: Object.freeze(REASON_ORDER.filter((reason) => reasons.has(reason))),
      }),
    );
  }

  const resolvedMarket = resolveMerchantMarket();

  return Object.freeze({
    offers: Object.freeze(offers),
    excluded: Object.freeze(excluded),
    market: resolvedMarket,
    activationBlockedReasons: Object.freeze(
      resolvedMarket.status === "APPROVED" ? [] : [MERCHANT_MARKET_UNRESOLVED],
    ),
  });
}
