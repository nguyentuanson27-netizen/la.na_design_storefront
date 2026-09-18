/**
 * U27 — the boundary from the PDP's storefront projection to published product JSON-LD.
 *
 * It answers one question: which of this product's variants may appear as their own `Product` and
 * exact `Offer`, either under a real `ProductGroup` or as the exact standalone survivor after a
 * family collapses, and with which facts. Everything it publishes already has an owner, and it
 * reuses that owner rather than re-deriving the answer:
 *
 * - addressability and the variant URL — the U12 deep-link contract;
 * - price and availability — the PDP projection, priced by the same rule the page renders with;
 * - images — the trusted media the catalog already resolved for this product's gallery;
 * - product-level identity — the external `pancakeProductId` the storefront already treats as this
 *   product's public identity;
 * - variant identifier — ADR 0008's manufacturer MPN (`pancakeDisplayId`), kept server-only until
 *   this serialization boundary.
 *
 * Nothing here reads the database. The page repository supplies the projection and the reviewed MPN
 * map together, so publishing structured data adds no extra catalog or pricing query.
 */

import {
  classifyExternalIdentifier,
  MERCHANT_ID_MAX_LENGTH,
} from "../commerce/merchant-identity-audit.ts";
import { toOptionIdentityKey } from "../commerce/storefront-product.ts";
import {
  selectStorefrontProductLevelOptions,
  type StorefrontProductProjection,
  type StorefrontProjectionOption,
} from "../commerce/storefront-projection.ts";
import {
  buildStandaloneVariantDeepLinkPath,
  resolveDeepLinkedVariantSelection,
} from "../commerce/storefront-variant-deep-link.ts";
import {
  buildProductStructuredData,
  isPublishableIdentifier,
  isPublishableMpn,
  type ProductStructuredDataDocument,
  type StructuredDataAvailability,
  type StructuredDataProductGroup,
  type StructuredDataVariant,
  type StructuredDataVariantDimension,
} from "./structured-data.ts";

type StorefrontStructuredDataProduct = Readonly<{
  /** Product-level external identity; the same one the page already reports to analytics. */
  pancakeProductId: string;
  slug: string;
  name: string;
  editorialDescription: string | null;
  media: Readonly<{
    gallery: readonly Readonly<{
      url: string;
      alt: string;
    }>[];
  }>;
  /** Server-resolved variant → gallery position, keyed by internal id and never published. */
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  /** ADR 0008 manufacturer MPNs, keyed by internal id; internal ids themselves never leave JSON-LD. */
  variantMpnById: Readonly<Record<string, string | null>>;
  /**
   * U32a website-owned SKUs, keyed the same way. Unlike the MPN this gates nothing: a variant with
   * no publishable SKU is still published, simply without one.
   */
  variantSkuById: Readonly<Record<string, string | null>>;
  /**
   * Whether this variant's mirrored inventory can state an availability at all, keyed by internal id
   * and never published. Resolved by the catalog read that still holds the raw warehouse rows; this
   * boundary only consumes the verdict, and reads no stock of its own.
   */
  variantAvailabilityResolvedById: Readonly<Record<string, boolean>>;
  projection: StorefrontProductProjection;
}>;

/**
 * This option's commerce state, when it can be stated exactly.
 *
 * Fail-closed, and price and availability are decided together on purpose: an offer is published
 * only when the price is fully resolved *and* the option is either buyable or out of stock for
 * stock reasons alone. A variant whose price never resolved is not published as sold out — that
 * would answer a pricing question with a stock claim.
 *
 * Merchant rejects zero/negative prices for ordinary apparel. U27 uses the same threshold for exact
 * variant publication so a zero-priced sibling cannot remain in JSON-LD after Merchant filtered it
 * out and thereby prevent the family from collapsing to Merchant's sole exact survivor.
 *
 * U27a adds the prior question: whether the catalog can state an availability for this variant at
 * all. A malformed mirrored quantity makes the storefront's own total meaningless — `[5, -3]` sums
 * to an ordinary 2 — so the projection's sold-out-or-buyable verdict, correct as a shopper-facing
 * fallback, is not a fact to publish. Unresolved is an omission and never a substitute claim: not
 * `OutOfStock`, not `InStock`, not a pre-order or back-order stand-in. A variant missing from the
 * map is unresolved too, so a caller that forgets to supply it publishes nothing rather than
 * publishing something unverified.
 */
function resolvePublishableOffer(
  option: StorefrontProjectionOption,
  availabilityResolved: boolean,
): Readonly<{
  price: number;
  availability: StructuredDataAvailability;
  availabilityDate: string | null;
}> | null {
  if (!availabilityResolved) return null;
  const { price } = option;
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  // I9 — the shared ADR 0011 decision, the same object the Merchant feed publishes from. This
  // function used to translate `purchasable`/`unavailableReason` itself, which is precisely the
  // independent translation ADR 0011 § Structured-data parity forbids: the feed and this markup
  // could describe one variant two ways. It now only decides whether to publish, never what.
  const { availability } = option;
  if (!availability.published) return null;
  return { price, availability: availability.schema, availabilityDate: availability.availabilityDate };
}

function resolveVariantImageUrl(
  product: StorefrontStructuredDataProduct,
  option: StorefrontProjectionOption,
): string | null {
  const index = product.galleryIndexByVariantId[option.id];
  // An index that addresses no resolved image — missing, out of range, or not a position at all —
  // simply does not select one, so there is nothing further to guard.
  return typeof index === "number" ? product.media.gallery[index]?.url ?? null : null;
}

/**
 * The dimensions these variants genuinely differ on.
 *
 * Compared through the option model's own identity rule rather than by raw string, because that is
 * the rule that decided these rows were distinct siblings in the first place. Mirrored catalog text
 * is inconsistently cased, and a family whose rows read `Đen` and `đen` varies by size alone — the
 * markup must not tell Google it offers two colours.
 */
function resolveVariesBy(
  variants: readonly StructuredDataVariant[],
): StructuredDataVariantDimension[] {
  const distinct = (key: "color" | "size") =>
    new Set(
      variants
        .map((variant) => variant[key])
        .filter((value): value is string => value !== null)
        .map(toOptionIdentityKey),
    ).size;

  const variesBy: StructuredDataVariantDimension[] = [];
  if (distinct("color") > 1) variesBy.push("COLOR");
  if (distinct("size") > 1) variesBy.push("SIZE");
  return variesBy;
}

/**
 * The external product identity, when it is publishable as one on both sides of the convergence
 * contract. U27's own public-identifier guard remains defense in depth, while Merchant's stricter
 * 50-code-point/no-whitespace classifier decides whether the same `item_group_id` could actually be
 * emitted by the feed. A value Merchant would reject cannot authorize an exact JSON-LD survivor.
 */
function readPublishableProductGroupID(pancakeProductId: string): string | null {
  const merchantReady =
    classifyExternalIdentifier(pancakeProductId, {
      maxLength: MERCHANT_ID_MAX_LENGTH,
      allowWhitespace: false,
    }) === "PRESENT";
  return merchantReady && isPublishableIdentifier(pancakeProductId) ? pancakeProductId : null;
}

/**
 * The variants this page may publish, each proved addressable and uniquely identified first.
 *
 * Every candidate's external variation identity is fed back through the U12 resolver against this
 * same projection, and only an identity that reselects *this* option survives. That resolver remains
 * the authority for the storefront's option model: a size-only family is valid and must not be
 * rejected merely because Merchant's apparel feed independently requires a color value. Separately,
 * ADR 0008 requires a current, bounded and unique manufacturer MPN. A duplicate/missing/malformed
 * MPN fails closed instead of silently substituting `VariantMirror.sku`, barcode, local CUID, or the
 * Pancake variation UUID as a different identifier type.
 *
 * The owner-approved family-collapse contract is a Merchant ↔ JSON-LD convergence rule, not a reason
 * to replace U27's dimensional model with Merchant's. Shared facts that must converge here — bounded
 * external offer identity, positive price, resolved availability and exact MPN — gate the exact
 * variant set. Option dimensional validity continues to be decided by U12/storefront addressability.
 *
 * Uniqueness is decided last, over the candidates that survived every other check — the same order
 * the Merchant mapper uses. It has to be: a variant already excluded on its own facts is not a
 * claimant to anything, so counting it would let one doomed row suppress a perfectly good sibling,
 * and the two consumers would publish different sets without either being wrong about duplicates.
 * When two *surviving* candidates share a part number, both are still dropped — the catalog cannot
 * say which one it names, and preferring either would be a guess.
 *
 * The resolver scans the option list, so this is quadratic in the number of options of one product
 * — a small in-memory array the page already holds, with no query behind it.
 */
function resolvePublishableVariants({
  origin,
  product,
}: Readonly<{
  origin: string;
  product: StorefrontStructuredDataProduct;
}>): StructuredDataVariant[] {
  if (readPublishableProductGroupID(product.pancakeProductId) === null) return [];

  const candidates: Readonly<{ mpn: string; variant: StructuredDataVariant }>[] = [];

  for (const option of product.projection.options) {
    if (
      classifyExternalIdentifier(option.pancakeVariationId, {
        maxLength: MERCHANT_ID_MAX_LENGTH,
        allowWhitespace: false,
      }) !== "PRESENT"
    ) {
      continue;
    }

    const reselected = resolveDeepLinkedVariantSelection({
      projection: product.projection,
      variantQuery: option.pancakeVariationId,
    });
    // The second half is redundant against today's resolver, which matches one exact external id or
    // none. It stays because it, not the resolver's current internals, is the property this file
    // depends on: the URL about to be published must open *this* variant. A resolver that ever
    // learned to fall back to a near match would otherwise start publishing wrong links silently.
    if (reselected === null || reselected.variantId !== option.id) continue;

    const variantPath = buildStandaloneVariantDeepLinkPath({
      slug: product.slug,
      pancakeVariationId: option.pancakeVariationId,
    });
    if (variantPath === null) continue;

    const mpn = product.variantMpnById[option.id];
    if (!isPublishableMpn(mpn)) continue;

    const offer = resolvePublishableOffer(
      option,
      product.variantAvailabilityResolvedById[option.id] === true,
    );
    if (offer === null) continue;

    candidates.push({
      mpn,
      variant: {
        url: new URL(variantPath, origin).href,
        mpn,
        sku: product.variantSkuById[option.id] ?? null,
        color: option.color,
        size: option.size,
        price: offer.price,
        availability: offer.availability,
        // I9 — the same persisted cycle date the Merchant feed publishes, from the same projection
        // option. `null` for everything except a live `BackOrder`, which is the only availability
        // Google requires a date for.
        availabilityDate: offer.availabilityDate,
        imageUrl: resolveVariantImageUrl(product, option),
      },
    });
  }

  const claimantsByMpn = new Map<string, number>();
  for (const candidate of candidates) {
    claimantsByMpn.set(candidate.mpn, (claimantsByMpn.get(candidate.mpn) ?? 0) + 1);
  }

  return candidates
    .filter((candidate) => claimantsByMpn.get(candidate.mpn) === 1)
    .map((candidate) => candidate.variant);
}

/**
 * The publishable variant family, or `null` when this product does not have one.
 *
 * A real `ProductGroup` needs a publishable product identity, at least two surviving variants and a
 * dimension those variants genuinely differ on. A single survivor is deliberately not a group; the
 * approved family-collapse contract publishes it as an exact standalone `Product` instead.
 */
function resolveProductGroup({
  product,
  variants,
}: Readonly<{
  product: StorefrontStructuredDataProduct;
  variants: readonly StructuredDataVariant[];
}>): StructuredDataProductGroup | null {
  const productGroupID = readPublishableProductGroupID(product.pancakeProductId);
  if (productGroupID === null || variants.length < 2) return null;

  const variesBy = resolveVariesBy(variants);
  if (variesBy.length === 0) return null;

  return { productGroupID, variesBy, variants };
}

/**
 * The exact standalone survivor under the approved family-collapse contract.
 *
 * A product that started with exactly one option is not a collapsed family and keeps U27's existing
 * product-level fallback with the canonical PDP URL. This path is therefore available only when a
 * standalone projection originally contained at least two options and the verified exact-variant
 * set has subsequently narrowed to one. Composite projections remain outside the v1 exact-variant
 * contract, and a malformed product identity cannot make JSON-LD publish an exact survivor that
 * Merchant would refuse.
 */
function resolveStandaloneSurvivor({
  product,
  variants,
}: Readonly<{
  product: StorefrontStructuredDataProduct;
  variants: readonly StructuredDataVariant[];
}>): StructuredDataVariant | null {
  if (product.projection.mode !== "standalone") return null;
  if (product.projection.options.length < 2) return null;
  if (readPublishableProductGroupID(product.pancakeProductId) === null) return null;
  return variants.length === 1 ? variants[0]! : null;
}

/**
 * The options the product-level fallback may answer from.
 *
 * Suppressing the exact per-variant claim is only half of failing closed: the fallback offer is
 * aggregated from these options, so an unresolved variant left in the list would republish the same
 * availability one node up — a family that collapses to a single sold-out survivor would still
 * advertise `InStock` on the strength of a sibling whose inventory the catalog cannot read.
 *
 * The filter matters in both directions. An unresolved sibling must not make the product claim
 * stock it cannot support, and must not drag the offer into the price-disagreement refusal either,
 * which would silently withhold an offer the surviving variant fully supports.
 */
function selectPublishableProductLevelOptions(
  product: StorefrontStructuredDataProduct,
): StorefrontProjectionOption[] {
  return selectStorefrontProductLevelOptions(product.projection).filter(
    (option) => product.variantAvailabilityResolvedById[option.id] === true,
  );
}

export function buildStorefrontProductStructuredData({
  origin,
  product,
}: Readonly<{
  origin: string;
  product: StorefrontStructuredDataProduct;
}>): ProductStructuredDataDocument {
  // Resolve the verified exact-variant set once, then decide only how that same set is represented:
  // a real family under ProductGroup, one exact standalone survivor, or neither. No consumer-specific
  // re-filtering is allowed between those representations.
  const publishableVariants = resolvePublishableVariants({ origin, product });

  return buildProductStructuredData({
    origin,
    product,
    // This remains the ordinary product-level fallback when there is no exact standalone survivor
    // and no publishable family. It is narrowed to variants whose inventory can state availability.
    variantOptions: selectPublishableProductLevelOptions(product),
    productGroup: resolveProductGroup({ product, variants: publishableVariants }),
    standaloneVariant: resolveStandaloneSurvivor({ product, variants: publishableVariants }),
  });
}
