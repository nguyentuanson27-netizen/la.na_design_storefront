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
        pancakeDisplayId: { startsWith: string } | { equals: string; mode: "insensitive" };
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

/** Inputs to the product page's feedback decision, each already scoped to the shop. */
export type ProductFeedbackInput = Readonly<{
  /** The product's split-off Pancake code, or `null` when its name carries none. */
  productCode: string | null;
  /**
   * How many present products in the shop carry that code (case-insensitively). `productCode` is
   * not a unique key in the mirror, so a tag can only be attributed to "this product" when the
   * count is exactly one.
   */
  productCodeOwnerCount: number;
  /** The `ANH-FEEDBACK-<code>` variants for that code. */
  taggedVariants: readonly FeedbackVariantRow[];
  /** The brand gallery, exactly as the homepage and `/feedback` resolve it. */
  brandImages: readonly FeedbackImage[];
}>;

/**
 * The feedback a product page shows: the product's own tagged photographs when it has any and its
 * code names it alone, else the brand gallery's first photographs, else nothing. Never a mix: the
 * heading has to say whose photographs these are.
 *
 * An ambiguous code -- two present products sharing it, which the mirror does not prevent -- fails
 * closed to the brand gallery rather than showing one product's customers on another's page.
 */
export function selectProductFeedback(
  input: ProductFeedbackInput,
  limit: number = PRODUCT_FEEDBACK_IMAGE_LIMIT,
): ProductFeedback | null {
  const hasBrandGallery = input.brandImages.length > 0;
  const code = input.productCode?.trim().toUpperCase() ?? "";

  if (code.length > 0 && input.productCodeOwnerCount === 1) {
    const tagged = input.taggedVariants.filter(
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
    images: Object.freeze(input.brandImages.slice(0, limit)),
    hasBrandGallery,
  });
}

export type ProductFeedbackReadClient = FeedbackReadClient & {
  productMirror: {
    findFirst(args: {
      where: { id: string; pancakeShopId: number };
      select: { productCode: true };
    }): Promise<{ productCode: string | null } | null>;
    count(args: {
      where: {
        pancakeShopId: number;
        isPresent: boolean;
        productCode: { equals: string; mode: "insensitive" };
      };
    }): Promise<number>;
  };
};

const FEEDBACK_VARIANT_SELECT = {
  id: true,
  pancakeDisplayId: true,
  pancakeImageUrls: true,
} as const;

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
    select: FEEDBACK_VARIANT_SELECT,
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

/**
 * How long a product page reuses one read of the brand gallery: the cadence `/feedback` already
 * re-reads the same mirror on (its route's `refreshAfterMs`), so a Pancake sync reaches product
 * pages no later than it reaches the gallery.
 */
export const BRAND_FEEDBACK_CACHE_TTL_MS = 60_000;

/**
 * The product page's feedback reads, bounded per request.
 *
 * Per product page view: one indexed lookup of the product's code, one count of present products
 * sharing it, and one read of exactly that code's `ANH-FEEDBACK-<code>` variants. The brand gallery
 * -- the only read that spans every feedback variant, and the same one the homepage makes -- is
 * shared across product pages per shop for `ttlMs`, with concurrent misses joining one read and a
 * failed read never cached.
 */
export function createProductFeedbackRepository(
  client: ProductFeedbackReadClient,
  options: Readonly<{ now?: () => number; ttlMs?: number }> = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? BRAND_FEEDBACK_CACHE_TTL_MS;
  const brandCache = new Map<number, { expiresAt: number; images: Promise<readonly FeedbackImage[]> }>();

  function readBrandImages(shopId: number): Promise<readonly FeedbackImage[]> {
    const cached = brandCache.get(shopId);
    if (cached && cached.expiresAt > now()) return cached.images;

    const images = listFeedbackVariants(client, shopId).then(mapFeedbackVariantsToImages);
    const entry = { expiresAt: now() + ttlMs, images };
    brandCache.set(shopId, entry);
    images.catch(() => {
      if (brandCache.get(shopId) === entry) brandCache.delete(shopId);
    });
    return images;
  }

  async function readTagged(shopId: number, productCode: string | null) {
    const code = productCode?.trim() ?? "";
    if (code.length === 0) return { productCodeOwnerCount: 0, taggedVariants: [] };
    const [productCodeOwnerCount, taggedVariants] = await Promise.all([
      client.productMirror.count({
        where: { pancakeShopId: shopId, isPresent: true, productCode: { equals: code, mode: "insensitive" } },
      }),
      client.variantMirror.findMany({
        where: {
          isPresent: true,
          pancakeDisplayId: { equals: `${FEEDBACK_DISPLAY_ID_PREFIX}${code}`, mode: "insensitive" },
          product: { pancakeShopId: shopId },
        },
        select: FEEDBACK_VARIANT_SELECT,
        orderBy: [{ pancakeDisplayId: "asc" }, { id: "asc" }],
      }),
    ]);
    return { productCodeOwnerCount, taggedVariants };
  }

  return {
    async readProductFeedback({
      shopId,
      productId,
    }: { shopId: number; productId: string }): Promise<ProductFeedback | null> {
      const brandImages = readBrandImages(shopId);
      const product = await client.productMirror.findFirst({
        where: { id: productId, pancakeShopId: shopId },
        select: { productCode: true },
      });
      const productCode = product?.productCode ?? null;
      const [tagged, brand] = await Promise.all([readTagged(shopId, productCode), brandImages]);
      return selectProductFeedback({ productCode, ...tagged, brandImages: brand });
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

/** The process-wide repository, so product pages share its brand-gallery cache. */
let sharedProductFeedbackRepository: ReturnType<typeof createProductFeedbackRepository> | null = null;

/** The product page's feedback, or `null` when there is none or the mirror cannot be read. */
export async function readProductFeedback(
  options: Readonly<{ productId: string; client?: ProductFeedbackReadClient; shopId?: number }>,
): Promise<ProductFeedback | null> {
  try {
    const shopId = options.shopId ?? readPancakeShopId();
    let repository: ReturnType<typeof createProductFeedbackRepository>;
    if (options.client) {
      repository = createProductFeedbackRepository(options.client);
    } else {
      sharedProductFeedbackRepository ??= createProductFeedbackRepository(
        (await import("../db/prisma.ts")).prisma as unknown as ProductFeedbackReadClient,
      );
      repository = sharedProductFeedbackRepository;
    }
    return await repository.readProductFeedback({ shopId, productId: options.productId });
  } catch {
    // Feedback is supporting content: a mirror failure must not take the product page down.
    return null;
  }
}
