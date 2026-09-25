import type { NavigationLink } from "./schema.ts";

/**
 * The Sale section's sub-listings: one ordered declaration of the crawlable routes under `/sale`.
 *
 * Same reasoning as `category.config.ts`: the navigation, the route manifest, the sitemap and the
 * indexable-path patterns all derive from this list rather than restating the slugs, so adding or
 * renaming a sale listing is one edit here instead of four that can disagree.
 *
 * `campaignKind` names which promotion campaigns a listing shows. `/sale` itself keeps showing
 * every active discount; each child narrows it to one campaign kind.
 */
export type SaleListingKind = "PROMOTION" | "FLASH_SALE";

export type SaleListingDefinition = NavigationLink & Readonly<{
  campaignKind: SaleListingKind;
}>;

export const SALE_ROOT_NAVIGATION: NavigationLink = { href: "/sale", label: "Sale" };

export const SALE_CHILD_NAVIGATION: readonly SaleListingDefinition[] = [
  { href: "/sale/uu-dai", label: "Ưu đãi", campaignKind: "PROMOTION" },
  { href: "/sale/flash-sale", label: "Flash Sale", campaignKind: "FLASH_SALE" },
];

/** Every sale sub-listing route path, in declared order. */
export const SALE_CHILD_ROUTE_PATHS: readonly string[] = SALE_CHILD_NAVIGATION.map(
  (listing) => listing.href,
);

export function saleListingByKind(kind: SaleListingKind): SaleListingDefinition {
  const listing = SALE_CHILD_NAVIGATION.find((candidate) => candidate.campaignKind === kind);
  if (!listing) throw new Error(`No sale listing is declared for ${kind}`);
  return listing;
}
