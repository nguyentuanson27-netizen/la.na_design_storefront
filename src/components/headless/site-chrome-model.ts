import { BRAND } from "../../brand/index.ts";
import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../../content/public-brand-facts.ts";
import { POLICY_HUB_TOPICS } from "../../routes/evergreen-model.ts";

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

export type SiteFooterLink = Readonly<{
  href: string;
  label: string;
}>;

export type SiteFooterModel = Readonly<{
  contact: typeof PUBLIC_CONTACT_FACTS;
  address: string;
  supportHours: string;
  legal: typeof PUBLIC_LEGAL_FACTS;
  supportLinks: readonly SiteFooterLink[];
  policyLinks: readonly SiteFooterLink[];
}>;

export type SiteChromeContent = Readonly<{
  promotion: SitePromotionModel;
  header: SiteHeaderModel;
  footer: SiteFooterModel;
}>;

export const DEFAULT_SITE_PROMOTION_HEADLINE = "Mua 3 tặng 1 · Mua 4 tặng 1 Set · Mua 5 giảm 10%";

export function buildSiteChromeContent(
  headerMedia: readonly CategoryMegaMedia[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): SiteChromeContent {
  const headline = env.LA_TOP_PROMOTION_HEADLINE?.trim() || DEFAULT_SITE_PROMOTION_HEADLINE;

  return {
    promotion: {
      label: "Chương trình khuyến mại",
      headline,
    },
    header: {
      megaMedia: headerMedia,
    },
    footer: {
      contact: PUBLIC_CONTACT_FACTS,
      address: describePublicAddress(),
      supportHours: describePublicSupportHours(),
      legal: PUBLIC_LEGAL_FACTS,
      supportLinks: POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "support").map(
        (topic) => Object.freeze({ href: topic.href, label: topic.title }),
      ),
      policyLinks: [
        Object.freeze({ href: "/about", label: `Về ${BRAND.identity.name}` }),
        ...POLICY_HUB_TOPICS.filter((topic) => topic.footerGroup === "policy").map(
          (topic) => Object.freeze({ href: topic.href, label: topic.title }),
        ),
      ],
    },
  };
}
