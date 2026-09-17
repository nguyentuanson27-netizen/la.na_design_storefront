import {
  describeGuestShippingPromotion,
  describeGuestShippingPromotionHeadline,
  readGuestShippingPolicy,
} from "../../commerce/guest-shipping-policy.ts";
import {
  buildPublicBrandFacts,
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
} from "../../content/public-brand-facts.ts";

/**
 * Everything the site chrome renders, decided here so the brand layer stays markup over props.
 *
 * Spec 06 §"Definition of done" holds `src/components/brand/*` to props and public behaviour
 * surfaces, with no direct reach into `@/commerce/*`. The masthead's promotion line and the footer's
 * trust facts are both derived from the guest shipping policy and the approved fact authority, so
 * the derivation lives on this side of the seam and a redraw receives the answers.
 *
 * One read of the policy serves both, where the promotion bar and the footer each used to read it.
 * The read is a pure function of the environment, so this changes nothing but the count.
 */

export type SitePromotionModel = Readonly<{
  /** The landmark's accessible name: short and stable, the headline is what it introduces. */
  label: string;
  headline: string;
}>;

export type CategoryMegaMedia = Readonly<{
  categoryKey: string;
  imageUrl: string;
  altText?: string | null;
}>;

export type SiteHeaderModel = Readonly<{
  megaMedia: readonly CategoryMegaMedia[];
}>;

export type SiteFooterModel = Readonly<{
  facts: ReturnType<typeof buildPublicBrandFacts>;
  contact: typeof PUBLIC_CONTACT_FACTS;
  address: string;
  supportHours: string;
}>;

export type SiteChromeContent = Readonly<{
  promotion: SitePromotionModel;
  header: SiteHeaderModel;
  footer: SiteFooterModel;
}>;

export function buildSiteChromeContent(
  headerMedia: readonly CategoryMegaMedia[] = [],
): SiteChromeContent {
  const policy = readGuestShippingPolicy();

  return {
    promotion: {
      label: describeGuestShippingPromotion(policy).title,
      headline: describeGuestShippingPromotionHeadline(policy),
    },
    header: {
      megaMedia: headerMedia,
    },
    footer: {
      facts: buildPublicBrandFacts(policy),
      contact: PUBLIC_CONTACT_FACTS,
      address: describePublicAddress(),
      supportHours: describePublicSupportHours(),
    },
  };
}
