import {
  parseHomepageImageSrc,
  readFeedbackContent,
  resolveFeedbackContentWithImages,
  type FeedbackContent,
  type FeedbackImage,
} from "../content/homepage-content.ts";
import { HOMEPAGE_CONFIG } from "../content/homepage.config.ts";

export type FeedbackVariantRow = Readonly<{
  id: string;
  pancakeDisplayId: string | null;
  sku: string | null;
  pancakeImageUrls: unknown;
}>;

export type FeedbackReadClient = {
  variantMirror: {
    findMany(args: {
      where: {
        isPresent: boolean;
        OR: [
          { pancakeDisplayId: { contains: string; mode: "insensitive" } },
          { sku: { contains: string; mode: "insensitive" } },
          { product: { name: { contains: string; mode: "insensitive" } } },
        ];
      };
      select: {
        id: true;
        pancakeDisplayId: true;
        sku: true;
        pancakeImageUrls: true;
      };
      orderBy?: Array<{ pancakeDisplayId?: "asc" | "desc"; id?: "asc" | "desc" }>;
    }): Promise<FeedbackVariantRow[]>;
  };
};

/**
 * Pre-calibrated natural dimensions for editorial feedback images shipped in the config.
 */
const KNOWN_FEEDBACK_IMAGE_DIMENSIONS = new Map<string, { width: number; height: number }>(
  HOMEPAGE_CONFIG.feedback.images.map((img) => [img.src, { width: img.width, height: img.height }]),
);

/**
 * Maps database variants (e.g. `ANH-FEEDBACK-01`, `ANH-FEEDBACK-02`) to a validated,
 * deduplicated list of FeedbackImage items ordered naturally by variant SKU/displayId.
 *
 * If the database has no feedback rows or valid images, falls back to `HOMEPAGE_CONFIG.feedback.images`.
 */
export function mapFeedbackVariantsToImages(
  variants: readonly FeedbackVariantRow[],
): readonly FeedbackImage[] {
  if (variants.length === 0) {
    return HOMEPAGE_CONFIG.feedback.images;
  }

  // Sort variants naturally by display ID / SKU (e.g. ANH-FEEDBACK-01 before ANH-FEEDBACK-02)
  const sorted = [...variants].sort((a, b) => {
    const keyA = (a.pancakeDisplayId || a.sku || a.id).trim();
    const keyB = (b.pancakeDisplayId || b.sku || b.id).trim();
    return keyA.localeCompare(keyB, undefined, { numeric: true, sensitivity: "base" });
  });

  const seen = new Set<string>();
  const images: FeedbackImage[] = [];

  for (const variant of sorted) {
    const urls = Array.isArray(variant.pancakeImageUrls)
      ? (variant.pancakeImageUrls as unknown[])
      : [];

    for (const raw of urls) {
      if (typeof raw !== "string") continue;
      const src = parseHomepageImageSrc(raw);
      if (!src || seen.has(src)) continue;
      seen.add(src);

      const knownDim = KNOWN_FEEDBACK_IMAGE_DIMENSIONS.get(src);
      // Canonical 3:4 portrait ratio (1536x2048) as fallback for new photos without measured size
      images.push(
        Object.freeze({
          src,
          alt: "",
          width: knownDim?.width ?? 1536,
          height: knownDim?.height ?? 2048,
        }),
      );
    }
  }

  return images.length > 0 ? Object.freeze(images) : HOMEPAGE_CONFIG.feedback.images;
}

export function createFeedbackRepository(client: FeedbackReadClient) {
  return {
    async listFeedbackImages(): Promise<readonly FeedbackImage[]> {
      const variants = await client.variantMirror.findMany({
        where: {
          isPresent: true,
          OR: [
            { pancakeDisplayId: { contains: "FEEDBACK", mode: "insensitive" } },
            { sku: { contains: "FEEDBACK", mode: "insensitive" } },
            { product: { name: { contains: "feedback", mode: "insensitive" } } },
          ],
        },
        select: {
          id: true,
          pancakeDisplayId: true,
          sku: true,
          pancakeImageUrls: true,
        },
        orderBy: [{ pancakeDisplayId: "asc" }, { id: "asc" }],
      });

      return mapFeedbackVariantsToImages(variants);
    },
  };
}

/**
 * Loads feedback content dynamically from the product mirror in the database.
 * Falls back to static repository config if database query fails or yields no images.
 */
export async function readDynamicFeedbackContent(
  client?: FeedbackReadClient,
): Promise<FeedbackContent | null> {
  try {
    const dbClient = client ?? ((await import("../db/prisma.ts")).prisma as unknown as FeedbackReadClient);
    const repository = createFeedbackRepository(dbClient);
    const images = await repository.listFeedbackImages();
    if (images.length > 0) {
      return resolveFeedbackContentWithImages(images);
    }
  } catch {
    // Database may be unavailable in unit tests or offline build environments
  }
  return readFeedbackContent();
}
