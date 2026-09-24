/**
 * Homepage editorial refresh — the repository-owned content the approved spec leaves to config.
 *
 * Authority: `docs/specs/homepage-editorial-refresh.md` §8. This file owns **only** values that
 * have no canonical owner elsewhere, and deliberately holds nothing that does:
 *
 * - no manual SPECIAL DEALS product list — that is `HomepageFeaturedProduct`;
 * - no category images — those are `CategoryEditorialMedia.heroImageUrl`;
 * - no category labels or hrefs — those are `CATEGORY_NAVIGATION`;
 * - no promo titles — the visible name of a promo tile is its collection's `CollectionDefinition.title`.
 *
 * Every value the owner has not supplied yet is `null` (or an empty list), and the section that
 * needs it omits itself. §17 of the spec lists these as pending content, not missing requirements:
 * nothing here may be filled with invented copy, collections or photography to make a screenshot
 * look complete. Validation happens at one boundary, `homepage-content.ts`, not in the page.
 */

/** One collection promo tile. The visible title is derived from the collection, never stored here. */
export type CollectionPromoSlotConfig = Readonly<{
  collectionSlug: string;
  /** A stable local `/public` path, or a URL that passes the trusted product-media contract. */
  imageSrc: string;
  ctaLabel: string;
}>;

/** A promo row is exactly two slots. A `null` slot is unmapped, and an unmapped slot omits its row. */
export type CollectionPromoRowConfig = readonly [
  CollectionPromoSlotConfig | null,
  CollectionPromoSlotConfig | null,
];

export type FeedbackImageConfig = Readonly<{
  /** A stable local `/public` path, or a URL that passes the trusted product-media contract. */
  src: string;
  /**
   * A manually authored accessibility decision: descriptive text when the photo is informative, or
   * an explicit `""` when it is purely decorative. Never generated.
   */
  alt: string;
}>;

export type HomepageConfig = Readonly<{
  /**
   * Only what genuinely varies. The section's role and its `SPECIAL DEALS` title are fixed by the
   * spec (§7.2) and live in code (`SPECIAL_DEALS_TITLE`), so a config edit cannot redefine them.
   */
  specialDeals: Readonly<{
    supportingCopy: string | null;
    /** The one collection that supplies the fallback products and the `Xem thêm` destination. */
    sourceCollectionSlug: string | null;
    ctaLabel: string;
  }>;
  /** Row A sits before YOUR NEXT FAVOURITE, row B after it. Same component, same schema. */
  promoRows: readonly [CollectionPromoRowConfig, CollectionPromoRowConfig];
  categoryDiscovery: Readonly<{
    title: string;
    description: string | null;
  }>;
  feedback: Readonly<{
    /** Section heading on the homepage and the `/feedback` page heading. */
    title: string | null;
    ctaLabel: string;
    metadataTitle: string | null;
    metadataDescription: string | null;
    /** Manually selected and ordered. The homepage rail and `/feedback` show them in this order. */
    images: readonly FeedbackImageConfig[];
  }>;
}>;

export const HOMEPAGE_CONFIG: HomepageConfig = {
  specialDeals: {
    // Pending (§17): optional supporting line.
    supportingCopy: null,
    // Pending (§17): the source collection has not been named yet, so the section omits itself.
    sourceCollectionSlug: null,
    ctaLabel: "Xem thêm",
  },
  // Pending (§17): all four collection promo mappings and their homepage images/CTA copy.
  promoRows: [
    [null, null],
    [null, null],
  ],
  categoryDiscovery: {
    title: "YOUR NEXT FAVOURITE",
    description: "You might’ve just found it",
  },
  feedback: {
    // Pending (§17): the heading, the metadata copy and the photographs themselves. Until all of
    // them are supplied the homepage rail omits itself and `/feedback` is not published.
    title: null,
    ctaLabel: "Xem thêm",
    metadataTitle: null,
    metadataDescription: null,
    images: [],
  },
};
