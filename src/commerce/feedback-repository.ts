import {
  parseHomepageImageSrc,
  resolveFeedbackContentWithImages,
  type FeedbackContent,
  type FeedbackImage,
} from "../content/homepage-content.ts";
import { HOMEPAGE_CONFIG } from "../content/homepage.config.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";

const FEEDBACK_DISPLAY_ID_PREFIX = "ANH-FEEDBACK-";

/** At most this many photographs on one product page's feedback rail. */
export const PRODUCT_FEEDBACK_IMAGE_LIMIT = 12;

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
 * The product a feedback variant is tagged to, read from its display ID.
 *
 * `ANH-FEEDBACK-01` (a bare ordinal) is brand feedback, as every mirrored row was before products
 * could be tagged. `ANH-FEEDBACK-SV605` is feedback for the product whose split-off Pancake code is
 * `SV605` (`splitTrailingProductCode`); that variant's images are the product's photographs. A code
 * always mixes letters and digits, so a remainder with no letter can only be an ordinal. Matching is
 * case-insensitive, because both halves are typed by hand in Pancake.
 */
export function parseFeedbackProductCode(displayId: string | null): string | null {
  if (displayId === null || !displayId.startsWith(FEEDBACK_DISPLAY_ID_PREFIX)) return null;
  const remainder = displayId.slice(FEEDBACK_DISPLAY_ID_PREFIX.length).trim();
  return /[A-Za-z]/.test(remainder) ? remainder.toUpperCase() : null;
}

function sortByDisplayId(variants: readonly FeedbackVariantRow[]): FeedbackVariantRow[] {
  return [...variants].sort((a, b) => {
    const keyA = (a.pancakeDisplayId || a.id).trim();
    const keyB = (b.pancakeDisplayId || b.id).trim();
    return keyA.localeCompare(keyB, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** Every trusted, distinct image URL on the variants, in display-ID order. */
function collectImageSources(variants: readonly FeedbackVariantRow[]): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const variant of sortByDisplayId(variants)) {
    const urls = Array.isArray(variant.pancakeImageUrls)
      ? (variant.pancakeImageUrls as unknown[])
      : [];
    for (const raw of urls) {
      if (typeof raw !== "string") continue;
      const src = parseHomepageImageSrc(raw);
      if (!src || seen.has(src)) continue;
      seen.add(src);
      sources.push(src);
    }
  }
  return sources;
}

/**
 * Maps mirrored ANH-FEEDBACK-* variants to the feedback gallery.
 *
 * The uncropped gallery requires truthful natural dimensions. Pancake's mirrored image list only
 * contains URLs, so a newly synced URL is publishable only after its natural dimensions have been
 * calibrated in repository config. Until then the dynamic gallery fails closed instead of
 * inventing an aspect ratio or publishing images from another source.
 *
 * Product-tagged variants (`parseFeedbackProductCode`) join the gallery only once calibrated, and
 * an uncalibrated one is skipped rather than emptying it: product photographs are added in Pancake
 * one product at a time, and each must not take the whole brand gallery down until a developer
 * measures it. The product page shows them meanwhile, because its rail crops to a fixed box.
 */
export function mapFeedbackVariantsToImages(
  variants: readonly FeedbackVariantRow[],
): readonly FeedbackImage[] {
  const scopedVariants = variants.filter(isFeedbackVariant);
  if (scopedVariants.length === 0) {
    return Object.freeze([]);
  }

  const brandSources = new Set(
    collectImageSources(
      scopedVariants.filter((variant) => parseFeedbackProductCode(variant.pancakeDisplayId) === null),
    ),
  );
  const images: FeedbackImage[] = [];

  for (const src of collectImageSources(scopedVariants)) {
    const knownDimension = KNOWN_FEEDBACK_IMAGE_DIMENSIONS.get(src);
    if (!knownDimension) {
      if (!brandSources.has(src)) continue;
      return Object.freeze([]);
    }

    images.push(
      Object.freeze({
        src,
        alt: "",
        width: knownDimension.width,
        height: knownDimension.height,
      }),
    );
  }

  return Object.freeze(images);
}

/** A product page feedback photograph. Its natural size is `null` until calibrated in config. */
export type ProductFeedbackImage = Readonly<{
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}>;

export type ProductFeedback = Readonly<{
  /** `product` when the photographs are of this product, `brand` for the brand-wide fallback. */
  scope: "product" | "brand";
  images: readonly ProductFeedbackImage[];
  /** Whether the brand gallery has photographs, i.e. whether `/feedback` is worth linking to. */
  hasBrandGallery: boolean;
}>;

/**
 * The feedback a product page shows: the product's own tagged photographs when it has any, else
 * the brand gallery's first photographs, else nothing. Never a mix: the heading has to say whose
 * photographs these are.
 */
export function selectProductFeedback(
  variants: readonly FeedbackVariantRow[],
  productCode: string | null,
  limit: number = PRODUCT_FEEDBACK_IMAGE_LIMIT,
): ProductFeedback | null {
  const brandImages = mapFeedbackVariantsToImages(variants);
  const hasBrandGallery = brandImages.length > 0;
  const code = productCode?.trim().toUpperCase() ?? "";

  if (code.length > 0) {
    const tagged = variants.filter(
      (variant) => isFeedbackVariant(variant) && parseFeedbackProductCode(variant.pancakeDisplayId) === code,
    );
    const images = collectImageSources(tagged)
      .slice(0, limit)
      .map((src) => {
        const knownDimension = KNOWN_FEEDBACK_IMAGE_DIMENSIONS.get(src);
        return Object.freeze({
          src,
          alt: "",
          width: knownDimension?.width ?? null,
          height: knownDimension?.height ?? null,
        });
      });
    if (images.length > 0) {
      return Object.freeze({ scope: "product", images: Object.freeze(images), hasBrandGallery });
    }
  }

  if (!hasBrandGallery) return null;
  return Object.freeze({
    scope: "brand",
    images: Object.freeze(brandImages.slice(0, limit)),
    hasBrandGallery,
  });
}

export type ProductFeedbackReadClient = FeedbackReadClient & {
  productMirror: {
    findFirst(args: {
      where: { id: string; pancakeShopId: number };
      select: { productCode: true };
    }): Promise<{ productCode: string | null } | null>;
  };
};

async function listFeedbackVariants(
  client: FeedbackReadClient,
  shopId: number,
): Promise<FeedbackVariantRow[]> {
  return client.variantMirror.findMany({
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
}

export function createFeedbackRepository(client: FeedbackReadClient) {
  return {
    async listFeedbackImages({ shopId }: { shopId: number }): Promise<readonly FeedbackImage[]> {
      return mapFeedbackVariantsToImages(await listFeedbackVariants(client, shopId));
    },
  };
}

export function createProductFeedbackRepository(client: ProductFeedbackReadClient) {
  return {
    async readProductFeedback({
      shopId,
      productId,
    }: { shopId: number; productId: string }): Promise<ProductFeedback | null> {
      const [variants, product] = await Promise.all([
        listFeedbackVariants(client, shopId),
        client.productMirror.findFirst({
          where: { id: productId, pancakeShopId: shopId },
          select: { productCode: true },
        }),
      ]);
      return selectProductFeedback(variants, product?.productCode ?? null);
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
    // The mirror is the only feedback-selection authority. Fail closed if it is unavailable.
  }
  return null;
}

/** The product page's feedback, or `null` when there is none or the mirror cannot be read. */
export async function readProductFeedback(
  options: Readonly<{ productId: string; client?: ProductFeedbackReadClient; shopId?: number }>,
): Promise<ProductFeedback | null> {
  try {
    const shopId = options.shopId ?? readPancakeShopId();
    const dbClient =
      options.client
      ?? ((await import("../db/prisma.ts")).prisma as unknown as ProductFeedbackReadClient);
    return await createProductFeedbackRepository(dbClient).readProductFeedback({
      shopId,
      productId: options.productId,
    });
  } catch {
    // Feedback is supporting content: a mirror failure must not take the product page down.
    return null;
  }
}
