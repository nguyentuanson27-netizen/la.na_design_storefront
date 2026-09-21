import { parseTrustedProductImageUrl } from "../commerce/product-media.ts";

/**
 * Which hero slides the homepage may show, as one pure function.
 *
 * Master spec §17 allows 2–3 campaign slides, one static hero at exactly one slide, and nothing at
 * all at zero. The three states are decided here rather than in the component so the rule that
 * silently degrades -- an untrusted image, an off-site destination, a fourth slide -- is pinned by
 * domain tests with no browser and no database.
 *
 * This file deliberately knows nothing about where a candidate came from. The homepage currently
 * maps published collections that carry hero media into `HomeHeroSlideCandidate`, because that is
 * the only real, admin-owned image + destination pair that exists today. When a campaign owner is
 * approved, only that one mapping in `home.ts` moves: the validation below, the component and every
 * test against them are written against the candidate shape, not against collections.
 *
 * Absence stays absence. A slide with no trusted image is dropped rather than rendered against a
 * placeholder, and zero surviving slides means the homepage omits the hero region entirely -- which
 * is the approved state while campaign assets are pending, not a broken carousel.
 */

/** Master spec §17: at most three campaign slides. */
export const HOME_HERO_MAX_SLIDES = 3;

/** Master spec §17: the CTA wording is approved copy, not a per-slide choice. */
export const HOME_HERO_CTA_LABEL = "MUA NGAY";

export type HomeHeroSlideCandidate = Readonly<{
  /** Unvalidated media URL; anything the trusted-media contract rejects drops the slide. */
  imageUrl: string | null;
  /** Optional mobile-optimized media URL. */
  mobileImageUrl?: string | null;
  /** Where the CTA goes. Must be an internal path -- the hero never sends a shopper off-site. */
  href: string;
  /**
   * Real name of the thing behind the slide, used as the image's alt text.
   *
   * §17 puts no title overlay on a slide, but the image still needs an accessible name, and the
   * honest one is the destination's own name rather than invented campaign copy.
   */
  label: string;
}>;

export type HomeHeroSlide = Readonly<{
  imageUrl: string;
  mobileImageUrl?: string;
  href: string;
  label: string;
}>;

/** An internal path, and not a protocol-relative URL that would leave the site. */
function isInternalPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function parseHeroSlideImageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // Allow internal site assets (e.g. /banners/...)
  if (isInternalPath(trimmed) && /\.(jpg|jpeg|png|webp)$/i.test(trimmed)) {
    return trimmed;
  }
  return parseTrustedProductImageUrl(trimmed);
}

export function buildHomeHeroSlides(
  candidates: readonly HomeHeroSlideCandidate[],
): readonly HomeHeroSlide[] {
  const slides: HomeHeroSlide[] = [];

  for (const candidate of candidates) {
    if (slides.length === HOME_HERO_MAX_SLIDES) break;

    // Re-validated here rather than trusted from the caller: the same contract the rest of the
    // storefront's media goes through, so a row edited around the admin boundary cannot put an
    // arbitrary origin into the homepage's largest image.
    const imageUrl = parseHeroSlideImageUrl(candidate.imageUrl);
    if (imageUrl === null) continue;
    if (!isInternalPath(candidate.href)) continue;

    const label = candidate.label.trim();
    if (label.length === 0) continue;

    const mobileImageUrl = candidate.mobileImageUrl
      ? parseHeroSlideImageUrl(candidate.mobileImageUrl) ?? undefined
      : undefined;

    slides.push(
      Object.freeze({
        imageUrl,
        ...(mobileImageUrl !== undefined ? { mobileImageUrl } : {}),
        href: candidate.href,
        label,
      }),
    );
  }

  return Object.freeze(slides);
}
