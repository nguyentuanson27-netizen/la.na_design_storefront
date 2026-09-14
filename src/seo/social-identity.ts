import { BRAND, MARKET_VN } from "../brand/index.ts";

/**
 * The brand identity a social card carries, in one place.
 *
 * The product detail page and the root fallback have to agree about what the brand's card looks
 * like — same name, same image, same alt text — or a share from a collection page and a share from
 * a product page would present the site as two different brands. They are separate metadata
 * builders answering to separate contracts, so the agreement lives here rather than in either of
 * them.
 *
 * Everything here reads from Brand Config. No social handle, contact channel or business claim
 * belongs in this file: those live in `BRAND.contact` and are published on the `Organization`
 * entity — a share card is not a brand mark, a contact channel or a business identity, and merging
 * them would blur three different contracts into one file.
 */

export const SITE_NAME = BRAND.identity.name;

/**
 * The website-owned branded card, served by Next from `src/app/` as a file-based asset.
 *
 * Referenced as a path, never a full URL: it is resolved against whichever trusted origin the
 * server owns at request time, so it follows the origin rather than pinning a hostname. The slug
 * has to match the route directory; a domain test pins that so the card cannot 404.
 */
export const SOCIAL_FALLBACK_PATH = `/${BRAND.identity.socialCardSlug}.png`;

export const SOCIAL_FALLBACK_ALT = BRAND.identity.socialCardAlt;

/** The site's own locale, matching the `lang` the root layout serves. */
export const SITE_LOCALE = `${MARKET_VN.language}_${MARKET_VN.country}`;
