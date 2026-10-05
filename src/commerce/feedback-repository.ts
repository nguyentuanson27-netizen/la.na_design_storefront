import {
  parseHomepageImageSrc,
  readFeedbackContent,
  resolveFeedbackContentWithImages,
  type FeedbackContent,
  type FeedbackImage,
} from "../content/homepage-content.ts";
import { HOMEPAGE_CONFIG } from "../content/homepage.config.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";

const FEEDBACK_DISPLAY_ID_PREFIX = "ANH-FEEDBACK-";

export type FeedbackVariantRow = Readonly<{
  id: string;
  pancakeDisplayId: string | null;
  pancakeImageUrls: unknown;
}>;

export type FeedbackReadClient = {
  variantMirror: {
    findMany(args: {
      where: {
        isPresent: boolean;
        pancakeDisplayId: { startsWith: string };
        product: { pancakeShopId: number };
      };
      select: {
        id: true;
        pancakeDisplayId: true;
        pancakeImageUrls: true;
      };
      orderBy?: Array<{ pancakeDisplayId?: "asc" | "desc"; id?: "asc" | "desc" }>;
    }): Promise<FeedbackVariantRow[]>;
  };
};

const KNOWN_FEEDBACK_IMAGE_DIMENSIONS = new Map<string, { width: number; height: number }>(
  HOMEPAGE_CONFIG.feedback.images.map((image) => [
    image.src,
    { width: image.width, height: image.height },
  ]),
);

function isFeedbackVariant(variant: FeedbackVariantRow): boolean {
  return variant.pancakeDisplayId?.startsWith(FEEDBACK_DISPLAY_ID_PREFIX) === true;
}

/**
 * Maps mirrored ANH-FEEDBACK-* variants to the feedback gallery.
 *
 * The uncropped gallery requires truthful natural dimensions. Pancake's mirrored image list only
 * contains URLs, so a newly synced URL is publishable only after its natural dimensions have been
 * calibrated in repository config. Until then the whole dynamic set falls back to the last reviewed
 * static gallery rather than inventing an aspect ratio or silently dropping an image.
 */
export function mapFeedbackVariantsToImages(
  variants: readonly FeedbackVariantRow[],
): readonly FeedbackImage[] {
  const scopedVariants = variants.filter(isFeedbackVariant);
  if (scopedVariants.length === 0) {
    return HOMEPAGE_CONFIG.feedback.images;
  }

  const sorted = [...scopedVariants].sort((a, b) => {
    const keyA = (a.pancakeDisplayId || a.id).trim();
    const keyB = (b.pancakeDisplayId || b.id).trim();
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

      const knownDimension = KNOWN_FEEDBACK_IMAGE_DIMENSIONS.get(src);
      if (!knownDimension) {
        return HOMEPAGE_CONFIG.feedback.images;
      }

      seen.add(src);
      images.push(
        Object.freeze({
          src,
          alt: "",
          width: knownDimension.width,
          height: knownDimension.height,
        }),
      );
    }
  }

  return images.length > 0 ? Object.freeze(images) : HOMEPAGE_CONFIG.feedback.images;
}

export function createFeedbackRepository(client: FeedbackReadClient) {
  return {
    async listFeedbackImages({ shopId }: { shopId: number }): Promise<readonly FeedbackImage[]> {
      const variants = await client.variantMirror.findMany({
        where: {
          isPresent: true,
          pancakeDisplayId: { startsWith: FEEDBACK_DISPLAY_ID_PREFIX },
          product: { pancakeShopId: shopId },
        },
        select: {
          id: true,
          pancakeDisplayId: true,
          pancakeImageUrls: true,
        },
        orderBy: [{ pancakeDisplayId: "asc" }, { id: "asc" }],
      });

      return mapFeedbackVariantsToImages(variants);
    },
  };
}

export async function readDynamicFeedbackContent(
  options: Readonly<{ client?: FeedbackReadClient; shopId?: number }> = {},
): Promise<FeedbackContent | null> {
  try {
    const shopId = options.shopId ?? readPancakeShopId();
    const dbClient =
      options.client
      ?? ((await import("../db/prisma.ts")).prisma as unknown as FeedbackReadClient);
    const repository = createFeedbackRepository(dbClient);
    const images = await repository.listFeedbackImages({ shopId });
    if (images.length > 0) {
      return resolveFeedbackContentWithImages(images);
    }
  } catch {
    // Database/config may be unavailable in unit tests or offline build environments.
  }
  return readFeedbackContent();
}
