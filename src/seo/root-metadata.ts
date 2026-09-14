import type { Metadata } from "next";

import { BRAND } from "../brand/index.ts";
import {
  SITE_LOCALE,
  SITE_NAME,
  SOCIAL_FALLBACK_ALT,
  SOCIAL_FALLBACK_PATH,
} from "./social-identity.ts";

type RootMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
}>;

const DEFAULT_TITLE = BRAND.identity.headline;
const DEFAULT_DESCRIPTION = BRAND.identity.tagline;

export const GOOGLE_SITE_VERIFICATION = "N2OZE83tu6EA4bc-oP1u2uhDYBrDwLKJJCZstMm5lhs";

/**
 * The metadata every route inherits, including the social card it falls back to.
 *
 * Next merges route metadata over this one, so a page that builds its own Open Graph or Twitter
 * fields — a PDP with its own product image, title and URL — keeps them. What this supplies is the
 * answer for the routes that build none: the homepage, the collection index, the lookbook.
 *
 * Two things it deliberately does not do. It adds no canonical, because self-canonical for static
 * pages is its own decision gated on the search exposure contract. And it changes no indexing
 * policy: `robots` is the same expression of the exposure gate it always was. A branded share card
 * is presentation, and presentation is not permission to be indexed.
 */
export function buildRootMetadata({ origin, indexingEnabled }: RootMetadataInput): Metadata {
  const image = {
    url: new URL(SOCIAL_FALLBACK_PATH, origin).href,
    alt: SOCIAL_FALLBACK_ALT,
  };

  return {
    title: {
      default: DEFAULT_TITLE,
      template: `%s — ${BRAND.identity.name}`,
    },
    description: DEFAULT_DESCRIPTION,
    metadataBase: new URL(origin),
    robots: indexingEnabled ? undefined : { index: false, follow: false },
    openGraph: {
      type: "website",
      locale: SITE_LOCALE,
      siteName: SITE_NAME,
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      images: [image],
    },
    verification: {
      google: GOOGLE_SITE_VERIFICATION,
    },
  };
}
