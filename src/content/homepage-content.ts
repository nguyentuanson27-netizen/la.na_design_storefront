import { parseTrustedProductImageUrl } from "../commerce/product-media.ts";
import {
  HOMEPAGE_CONFIG,
  type FeedbackImageConfig,
  type HomepageConfig,
} from "./homepage.config.ts";

/**
 * The one validation boundary for `homepage.config.ts`.
 *
 * The config is repository-owned, but it is still input: an image path mistyped as a remote URL on
 * an unreviewed host, or a feedback page switched on before its copy exists, must fail closed here
 * rather than reach a shopper. Every consumer -- the homepage loader, `/feedback`, its metadata and
 * the sitemap -- asks this module, so they cannot disagree about whether something is publishable.
 */

/** The dedicated feedback gallery's canonical route (spec §7.6). */
export const FEEDBACK_PATH = "/feedback";

// A local file served from `/public`: rooted, no protocol-relative `//`, no traversal, an image
// extension, and nothing a query or fragment could vary. Characters are limited to what a stable
// repository path needs, so nothing here needs encoding.
const LOCAL_IMAGE_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]+\.(?:avif|jpe?g|png|webp)$/;
const MAX_LOCAL_IMAGE_PATH_LENGTH = 512;

/**
 * An editorial image source the storefront may render, or `null`.
 *
 * Local repository assets must be stable `/public` paths; anything remote goes through the same
 * trusted product-media contract every other storefront image does -- this adds no new media host.
 */
export function parseHomepageImageSrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    if (raw.length > MAX_LOCAL_IMAGE_PATH_LENGTH) return null;
    if (raw.includes("..") || raw.includes("//")) return null;
    return LOCAL_IMAGE_PATH.test(raw) ? raw : null;
  }
  return parseTrustedProductImageUrl(raw);
}

/** Trimmed, non-empty copy, or `null` for an absent or blank value. */
export function parseConfiguredCopy(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type FeedbackImage = Readonly<{
  src: string;
  alt: string;
  width?: number;
  height?: number;
}>;

export type FeedbackContent = Readonly<{
  title: string;
  ctaLabel: string;
  metadataTitle: string;
  metadataDescription: string;
  /** In the configured order. Never empty. */
  images: readonly FeedbackImage[];
}>;

function parseFeedbackImage(image: FeedbackImageConfig): FeedbackImage | null {
  const src = parseHomepageImageSrc(image.src);
  // `""` is a deliberate decorative decision, so it is kept; a missing value is not a decision.
  if (src === null || typeof image.alt !== "string") return null;
  const width =
    typeof image.width === "number" && Number.isInteger(image.width) && image.width > 0
      ? image.width
      : undefined;
  const height =
    typeof image.height === "number" && Number.isInteger(image.height) && image.height > 0
      ? image.height
      : undefined;
  return Object.freeze({
    src,
    alt: image.alt.trim(),
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
  });
}

/**
 * The feedback content, or `null` while any part of it is pending or invalid.
 *
 * All-or-nothing on purpose. The homepage rail needs a heading and photographs; `/feedback` needs
 * those plus owner-approved metadata copy (spec §7.6 forbids the route inventing it). A gallery with
 * one broken entry is not silently shortened either: the config is manually ordered, and dropping an
 * item would publish an order nobody chose. The shipped config is pinned valid by a domain test, so
 * this only fails closed on a real mistake.
 */
export function resolveFeedbackContent(
  feedback: HomepageConfig["feedback"],
): FeedbackContent | null {
  const title = parseConfiguredCopy(feedback.title);
  const ctaLabel = parseConfiguredCopy(feedback.ctaLabel);
  const metadataTitle = parseConfiguredCopy(feedback.metadataTitle);
  const metadataDescription = parseConfiguredCopy(feedback.metadataDescription);
  if (!title || !ctaLabel || !metadataTitle || !metadataDescription) return null;
  if (feedback.images.length === 0) return null;

  const images: FeedbackImage[] = [];
  for (const image of feedback.images) {
    const parsed = parseFeedbackImage(image);
    if (parsed === null) return null;
    images.push(parsed);
  }

  return Object.freeze({
    title,
    ctaLabel,
    metadataTitle,
    metadataDescription,
    images: Object.freeze(images),
  });
}

/** The shipped feedback content, resolved once through the boundary above. */
export function readFeedbackContent(): FeedbackContent | null {
  return resolveFeedbackContent(HOMEPAGE_CONFIG.feedback);
}
