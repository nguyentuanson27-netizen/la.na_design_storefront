import type { StructuredDataAvailability as SharedStructuredDataAvailability } from "../commerce/availability-projection.ts";
import { serializeVietnamAvailabilityDate } from "../commerce/availability-cycle.ts";
import {
  PUBLIC_CONTACT_FACTS,
  PUBLIC_SOCIAL_PROFILE_URLS,
  supportHoursSchemaTime,
} from "../content/public-brand-facts.ts";
import { BRAND } from "../brand/index.ts";

// One site name for the whole site: the same binding the social card and root metadata read.
const SITE_NAME = BRAND.identity.name;
const SCHEMA_CONTEXT = "https://schema.org" as const;
const IN_STOCK = "https://schema.org/InStock" as const;
const OUT_OF_STOCK = "https://schema.org/OutOfStock" as const;
/** I9 — ADR 0011's external term for a released product still accepting orders without ready stock. */
const BACK_ORDER = "https://schema.org/BackOrder" as const;

const SCHEMA_URI_BY_AVAILABILITY = {
  InStock: IN_STOCK,
  OutOfStock: OUT_OF_STOCK,
  BackOrder: BACK_ORDER,
} as const satisfies Record<StructuredDataAvailability, string>;
/**
 * How long a mirrored external identifier may be before this module refuses to publish it.
 *
 * Deliberately its own number rather than the addressing contract's `MAX_VARIANT_QUERY_LENGTH`.
 * That one bounds what a browser may send as `?variant=`; this one bounds what is written into a
 * public document. They share a value today and answer different questions, so widening one must
 * not silently widen the other. `isPublishableIdentifier` is exported so the caller that decides
 * publishability applies this rule rather than a second one that agrees by coincidence.
 */
const MAX_PUBLISHED_IDENTIFIER_LENGTH = 128;

/** ADR 0008 / Google Merchant MPN bound, reused by U27 for a truthful variant identifier. */
const MAX_PUBLISHED_MPN_LENGTH = 70;
const INVALID_PUBLISHED_IDENTIFIER_UNICODE_REGEX = /\p{Cc}|\p{Cf}|\p{Co}|\p{Cn}/u;
const SUPPLEMENTARY_CODE_POINT_REGEX = /[\u{10000}-\u{10FFFF}]/u;
const VARIANT_NAME_SEPARATOR = " — ";

/** The full schema.org URIs Google reads for the dimensions a variant family varies by. */
const SCHEMA_URI_BY_DIMENSION = {
  COLOR: "https://schema.org/color",
  SIZE: "https://schema.org/size",
} as const;

type StorefrontUnavailableReason =
  | "MAPPING_REQUIRED"
  | "AMBIGUOUS_OPTION"
  | "OUT_OF_STOCK"
  | "PRICE_UNRESOLVED"
  | null;

type StructuredDataVariantOption = Readonly<{
  price: number | null;
  purchasable: boolean;
  unavailableReason: StorefrontUnavailableReason;
}>;

/**
 * I9 — the shared schema.org vocabulary, imported rather than restated.
 *
 * This module used to own a second spelling (`IN_STOCK`/`OUT_OF_STOCK`) that a caller had to
 * translate into. ADR 0011 requires one availability decision behind both published surfaces, and
 * two vocabularies is how the translation crept back in.
 */
export type StructuredDataAvailability = SharedStructuredDataAvailability;

/**
 * One publishable variant, as the caller has already resolved it.
 *
 * Every field is a fact with an existing owner. In particular `url` is the exact deep link written
 * by the addressing contract that reads it back — this module never constructs a variant URL, so
 * there is no second URL implementation to drift from U12. `mpn` is the owner-confirmed LA Clothing
 * manufacturer identifier from ADR 0008; it is not the website-owned `VariantMirror.sku` field.
 */
export type StructuredDataVariant = Readonly<{
  url: string;
  mpn?: string | null;
  /** The website-owned `VariantMirror.sku`: Schema.org's merchant-specific identifier, not the MPN. */
  sku?: string | null;
  color: string | null;
  size: string | null;
  price: number;
  availability: StructuredDataAvailability;
  /**
   * I9 — ADR 0011: published only beside `BackOrder`, where Google requires it, and null on every
   * other state. Never fabricated.
   */
  availabilityDate?: string | null;
  imageUrl: string | null;
}>;

export type StructuredDataVariantDimension = keyof typeof SCHEMA_URI_BY_DIMENSION;

export type StructuredDataProductGroup = Readonly<{
  /** The reviewed external product-level identity. Never a local CUID or a presentation key. */
  productGroupID: string;
  /**
   * The dimensions the caller established these variants actually differ on — a domain answer,
   * because "do these two rows name the same colour?" is the option model's question, not this
   * module's. Naming them here rather than re-deriving them is what keeps `variesBy` from becoming
   * a stricter rule than the one that decided the variants were siblings in the first place.
   */
  variesBy: readonly StructuredDataVariantDimension[];
  variants: readonly StructuredDataVariant[];
}>;

type StructuredDataProduct = Readonly<{
  slug: string;
  name: string;
  editorialDescription: string | null;
  media: Readonly<{
    gallery: readonly Readonly<{
      url: string;
      alt: string;
    }>[];
  }>;
}>;

type OfferNode = {
  "@type": "Offer";
  url: string;
  priceCurrency: "VND";
  price: number;
  availability: (typeof SCHEMA_URI_BY_AVAILABILITY)[StructuredDataAvailability];
  /** I9 — ADR 0011: set only beside `BackOrder`, which is the only state Google dates. */
  availabilityStarts?: string;
};

type ProductVariantNode = {
  "@type": "Product";
  "@id": string;
  name: string;
  url: string;
  mpn?: string;
  sku?: string;
  color?: string;
  size?: string;
  image?: string[];
  offers: OfferNode;
};

type ProductGroupNode = {
  "@type": "ProductGroup";
  "@id": string;
  name: string;
  url: string;
  brand: {
    "@id": string;
  };
  description?: string;
  image?: string[];
  productGroupID: string;
  variesBy: string[];
  hasVariant: ProductVariantNode[];
};

type ProductNode = {
  "@type": "Product";
  "@id": string;
  name: string;
  url: string;
  brand: {
    "@id": string;
  };
  mpn?: string;
  sku?: string;
  color?: string;
  size?: string;
  description?: string;
  image?: string[];
  offers?: OfferNode;
};

type BreadcrumbListNode = {
  "@type": "BreadcrumbList";
  itemListElement: [
    {
      "@type": "ListItem";
      position: 1;
      name: "Trang chủ";
      item: string;
    },
    {
      "@type": "ListItem";
      position: 2;
      name: "Shop";
      item: string;
    },
    {
      "@type": "ListItem";
      position: 3;
      name: string;
    },
  ];
};

type PostalAddressNode = {
  "@type": "PostalAddress";
  streetAddress: string;
  addressLocality: string;
};

type OpeningHoursSpecificationNode = {
  "@type": "OpeningHoursSpecification";
  dayOfWeek: readonly string[];
  opens: string;
  closes: string;
};

type ContactPointNode = {
  "@type": "ContactPoint";
  contactType: string;
  telephone: string;
  email: string;
  hoursAvailable: OpeningHoursSpecificationNode;
};

/**
 * W6/U32b. The entity every other node points at, now carrying the owner-approved B2 contact facts.
 *
 * Every added property is a transcription of `PUBLIC_CONTACT_FACTS`, which is the sole authority for
 * them; nothing here is derived from the catalog, the UI copy or the served locale. The site footer
 * renders the same values from the same constant, so every fact marked up here is one a reader can
 * actually see on the page. The properties W6 also lists but that no approved source supplies —
 * `logo` above all — stay off the type, so adding one later is a deliberate edit here rather than
 * an accident at a call site.
 */
type OrganizationNode = {
  "@type": "Organization";
  "@id": string;
  name: typeof SITE_NAME;
  url: string;
  address: PostalAddressNode;
  contactPoint: ContactPointNode;
  sameAs: readonly string[];
};

type WebSiteNode = {
  "@type": "WebSite";
  "@id": string;
  name: typeof SITE_NAME;
  url: string;
  publisher: {
    "@id": string;
  };
};

export type ProductStructuredDataDocument = {
  "@context": typeof SCHEMA_CONTEXT;
  /**
   * Exactly one product-schema authority per page. A `ProductGroup` replaces the product-level
   * `Product` rather than joining it, so a variant family's exact per-variant offers can never sit
   * beside a contradictory product-level offer. A collapsed one-survivor family is represented by
   * one exact top-level `Product`, never a one-member `ProductGroup`.
   */
  "@graph": [ProductNode | ProductGroupNode, BreadcrumbListNode];
};

export type SiteStructuredDataDocument = {
  "@context": typeof SCHEMA_CONTEXT;
  "@graph": [OrganizationNode, WebSiteNode];
};

function buildSiteEntityIds(origin: string) {
  const rootUrl = new URL("/", origin).href;
  return {
    rootUrl,
    organizationId: `${rootUrl}#organization`,
    websiteId: `${rootUrl}#website`,
  };
}

function buildOffer(
  productUrl: string,
  variantOptions: readonly StructuredDataVariantOption[],
): OfferNode | undefined {
  if (variantOptions.length === 0) return undefined;

  const prices = variantOptions.map((option) => option.price);
  if (
    prices.some(
      (price): price is null => price === null || !Number.isFinite(price) || price < 0,
    )
  ) {
    return undefined;
  }

  const resolvedPrices = prices as number[];
  const price = resolvedPrices[0]!;
  if (resolvedPrices.some((candidate) => candidate !== price)) return undefined;

  const hasPurchasableVariant = variantOptions.some((option) => option.purchasable);
  const allUnavailableStateIsStockOnly = variantOptions.every(
    (option) => option.purchasable || option.unavailableReason === "OUT_OF_STOCK",
  );
  if (!allUnavailableStateIsStockOnly) return undefined;

  // Deliberately still `InStock`/`OutOfStock` only. This is the PRODUCT-level offer, and ADR 0011's
  // `backorder` carries a date that belongs to one variant's cycle — a product whose sizes sold out
  // on different days has no single date to publish here. A family that would need one therefore
  // states availability at the variant nodes instead, which is where the date is true.
  const availability = hasPurchasableVariant
    ? IN_STOCK
    : variantOptions.every((option) => option.unavailableReason === "OUT_OF_STOCK")
      ? OUT_OF_STOCK
      : undefined;
  if (!availability) return undefined;

  return {
    "@type": "Offer",
    url: productUrl,
    priceCurrency: "VND",
    price,
    availability,
  };
}

/**
 * Bounded, non-blank mirrored catalog text, published exactly as the catalog holds it. Trimming
 * would publish an identity no other consumer uses, so an untrimmed value is refused instead.
 */
export function isPublishableIdentifier(value: string): boolean {
  return (
    value.length > 0
    && value.length <= MAX_PUBLISHED_IDENTIFIER_LENGTH
    && value.trim() === value
  );
}

/**
 * Public structured data repeats the audited MPN trust boundary deliberately. The M1 audit remains
 * the operational evidence authority; this guard prevents a later malformed mirror value from
 * becoming public JSON-LD merely because an earlier catalog-wide audit was green.
 */
function isPublishableStoredIdentifier(
  value: string | null | undefined,
  maxCodePoints: number,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if (Array.from(value).length > maxCodePoints) return false;
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) return false;
  if (SUPPLEMENTARY_CODE_POINT_REGEX.test(value)) return false;
  return !INVALID_PUBLISHED_IDENTIFIER_UNICODE_REGEX.test(value);
}

export function isPublishableMpn(value: string | null | undefined): value is string {
  return isPublishableStoredIdentifier(value, MAX_PUBLISHED_MPN_LENGTH);
}

/**
 * The website-owned SKU carries no Merchant length contract of its own, so it takes the general
 * published-identifier bound. It shares the hardening with the MPN deliberately: both are stored
 * catalog strings reaching a public document, and two separately written rules that happen to agree
 * today are how one of them quietly stops agreeing later.
 */
export function isPublishableSku(value: string | null | undefined): value is string {
  return isPublishableStoredIdentifier(value, MAX_PUBLISHED_IDENTIFIER_LENGTH);
}

function hasUniquePublishableVariantMpns(variants: readonly StructuredDataVariant[]): boolean {
  const mpns: string[] = [];
  for (const variant of variants) {
    if (!isPublishableMpn(variant.mpn)) return false;
    mpns.push(variant.mpn);
  }
  return new Set(mpns).size === mpns.length;
}

/**
 * Google expects each nested variant `Product.name` to be more specific than the family name.
 * Compose that specificity only from the same factual option values already published on the node;
 * no category, audience, material, editorial copy, SKU, or identifier is inferred for naming.
 */
function buildVariantName(name: string, variant: StructuredDataVariant): string {
  const identifyingFacts = [variant.color, variant.size].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return identifyingFacts.length > 0
    ? [name, ...identifyingFacts].join(VARIANT_NAME_SEPARATOR)
    : name;
}

function hasSpecificVariantNames(
  name: string,
  variants: readonly StructuredDataVariant[],
): boolean {
  return variants.every((variant) => buildVariantName(name, variant) !== name);
}

function buildVariantNode(name: string, variant: StructuredDataVariant): ProductVariantNode {
  const node: ProductVariantNode = {
    "@type": "Product",
    "@id": `${variant.url}#product`,
    name: buildVariantName(name, variant),
    url: variant.url,
    offers: {
      "@type": "Offer",
      url: variant.url,
      priceCurrency: "VND",
      price: variant.price,
      availability: SCHEMA_URI_BY_AVAILABILITY[variant.availability],
      // Google accepts `availabilityStarts` on an Offer as the date the item becomes available,
      // and requires the matching `availability_date` in the feed. Emitted only when the shared
      // decision resolved one, so the two surfaces state the same day or neither states any.
      ...(() => {
        if (typeof variant.availabilityDate !== "string") return {};
        const serialized = serializeVietnamAvailabilityDate(variant.availabilityDate);
        return serialized === null ? {} : { availabilityStarts: serialized.schema };
      })(),
    },
  };

  // `publishedGroup` already requires every member to have a unique publishable MPN. Keep this
  // local guard as serialization defense if the helper is ever reused independently.
  if (isPublishableMpn(variant.mpn)) node.mpn = variant.mpn;
  // U32a: the merchant-specific identifier this shop assigned, on the variant it identifies. It
  // gates nothing - a variant family stays publishable whether or not its SKUs are.
  if (isPublishableSku(variant.sku)) node.sku = variant.sku;
  if (variant.color !== null) node.color = variant.color;
  if (variant.size !== null) node.size = variant.size;
  if (variant.imageUrl !== null) node.image = [variant.imageUrl];

  return node;
}

function buildStandaloneVariantNode(
  name: string,
  variant: StructuredDataVariant,
  organizationId: string,
): ProductNode {
  const variantNode = buildVariantNode(name, variant);
  return {
    ...variantNode,
    brand: {
      "@id": organizationId,
    },
  };
}

export function buildProductStructuredData({
  origin,
  product,
  variantOptions,
  productGroup = null,
  standaloneVariant = null,
}: Readonly<{
  origin: string;
  product: StructuredDataProduct;
  variantOptions: readonly StructuredDataVariantOption[];
  /**
   * The publishable variant family, when the caller resolved one. A real family requires at least
   * two members; a one-survivor state belongs in `standaloneVariant`, never a one-member group.
   */
  productGroup?: StructuredDataProductGroup | null;
  /**
   * The exact surviving standalone variant after family filtering/exclusion. This is already a
   * fully resolved U27 variant fact set, including the U12 URL and exact Offer facts.
   */
  standaloneVariant?: StructuredDataVariant | null;
}>): ProductStructuredDataDocument {
  const { rootUrl, organizationId } = buildSiteEntityIds(origin);
  const productUrl = new URL(`/shop/${product.slug}`, origin).href;
  const shopUrl = new URL("/shop", origin).href;
  const images = product.media.gallery.map((item) => item.url);

  // The caller decides whether a family is publishable — whether these rows really are siblings,
  // and whether their identity is one this catalog holds. This module still owns the serialization
  // boundary: a group needs a bounded product identity, a real family of at least two members, a
  // real varying dimension, variant-specific factual names, and a unique reviewed manufacturer MPN
  // on every variant before it can become public markup.
  const publishedGroup =
    productGroup !== null
    && isPublishableIdentifier(productGroup.productGroupID)
    && productGroup.variesBy.length > 0
    && productGroup.variants.length > 1
    && hasUniquePublishableVariantMpns(productGroup.variants)
    && hasSpecificVariantNames(product.name, productGroup.variants)
      ? productGroup
      : null;

  // The exact standalone path is fail-closed independently at the serialization boundary. The
  // caller already selected the survivor from the same verified U27 candidate set, but a malformed
  // MPN must never become public merely because a future caller bypasses that selection helper.
  const publishedStandaloneVariant =
    publishedGroup === null
    && standaloneVariant !== null
    && isPublishableMpn(standaloneVariant.mpn)
      ? standaloneVariant
      : null;

  const productNode: ProductNode | ProductGroupNode = publishedGroup !== null
    ? {
        "@type": "ProductGroup",
        "@id": `${productUrl}#product`,
        name: product.name,
        url: productUrl,
        brand: {
          "@id": organizationId,
        },
        productGroupID: publishedGroup.productGroupID,
        variesBy: publishedGroup.variesBy.map(
          (dimension) => SCHEMA_URI_BY_DIMENSION[dimension],
        ),
        // No group-level `offers`. The exact per-variant offers below are the whole point, and an
        // aggregate beside them would be a second, contradictory price authority on one page.
        hasVariant: publishedGroup.variants.map(
          (variant) => buildVariantNode(product.name, variant),
        ),
      }
    : publishedStandaloneVariant !== null
      ? buildStandaloneVariantNode(product.name, publishedStandaloneVariant, organizationId)
      : {
          "@type": "Product",
          "@id": `${productUrl}#product`,
          name: product.name,
          url: productUrl,
          brand: {
            "@id": organizationId,
          },
        };

  if (product.editorialDescription) {
    productNode.description = product.editorialDescription;
  }
  // An exact survivor may publish only its resolved variant image. If none resolved, omit image
  // rather than replacing variant-specific evidence with the generic product gallery. Ordinary
  // product/group documents keep the pre-existing product-gallery behavior.
  if (images.length > 0 && publishedStandaloneVariant === null) {
    productNode.image = images;
  }
  if (productNode["@type"] === "Product" && publishedStandaloneVariant === null) {
    const offer = buildOffer(productUrl, variantOptions);
    if (offer) {
      productNode.offers = offer;
    }
  }

  return {
    "@context": SCHEMA_CONTEXT,
    "@graph": [
      productNode,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Trang chủ",
            item: rootUrl,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Shop",
            item: shopUrl,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: product.name,
          },
        ],
      },
    ],
  };
}

export function buildSiteStructuredData({
  origin,
}: Readonly<{ origin: string }>): SiteStructuredDataDocument {
  const { rootUrl, organizationId, websiteId } = buildSiteEntityIds(origin);

  return {
    "@context": SCHEMA_CONTEXT,
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: SITE_NAME,
        url: rootUrl,
        address: {
          "@type": "PostalAddress",
          streetAddress: PUBLIC_CONTACT_FACTS.streetAddress,
          addressLocality: PUBLIC_CONTACT_FACTS.addressLocality,
        },
        contactPoint: {
          "@type": "ContactPoint",
          // The approved facts describe one support channel — a hotline that is also the Zalo
          // number, an email, and one set of hours covering both.
          contactType: "customer support",
          // Google's Organization guidance wants the country code here. The value is the approved
          // number in its international spelling, taken from the fact authority rather than
          // normalized in this module — nothing about an owner fact is derived at the markup site.
          telephone: PUBLIC_CONTACT_FACTS.telephoneInternational,
          email: PUBLIC_CONTACT_FACTS.email,
          hoursAvailable: {
            "@type": "OpeningHoursSpecification",
            // Every part of the hours comes from the one fact authority, the seven days included:
            // the footer renders the same statement, so neither can carry half of it.
            dayOfWeek: PUBLIC_CONTACT_FACTS.supportHours.days,
            opens: supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.opens),
            closes: supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.closes),
          },
        },
        sameAs: [...PUBLIC_SOCIAL_PROFILE_URLS],
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: SITE_NAME,
        url: rootUrl,
        publisher: {
          "@id": organizationId,
        },
      },
    ],
  };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
