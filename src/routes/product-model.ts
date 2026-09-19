import {
  isApprovedSizeGuideId,
  type ApprovedSizeGuideId,
} from "../brand/size-guide.config.ts";
import type { SizeChart } from "../brand/schema.ts";
import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type { StorefrontProjectionOption } from "../commerce/storefront-projection.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
} from "../commerce/storefront-product.ts";
import type { DeepLinkedVariantSelection } from "../commerce/storefront-variant-deep-link.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import { buildSizeGuideViewModel, type SizeGuideViewModel } from "./evergreen-model.ts";

/**
 * Everything the product route decides, as one pure function.
 *
 * Separate from `product.ts` because that file reaches the catalog runtime and `notFound()`. What
 * is left is what the page decided inline: where a deep link opens the gallery, which editorial
 * blocks have anything to say, and the related grid's cards.
 */

export type ProductMappedSizeGuide = Readonly<{
  id: ApprovedSizeGuideId;
  chart: SizeChart;
  tolerance: SizeGuideViewModel["tolerance"];
  circumferenceSemanticsNote: string;
  guidanceNote: string;
}>;

export type ProductEditorial = Readonly<{
  description: string | null;
  material: string | null;
  craftDetails: readonly string[];
  /** The exact manually mapped approved guide; null means no PDP trigger. */
  sizeGuide: ProductMappedSizeGuide | null;
  careInstructions: string | null;
  /** Whether the detail-notes section has any product-specific row at all. */
  hasNotes: boolean;
}>;

export type RelatedProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  media?: StorefrontProductMedia | null;
  variants: StorefrontVariantFacts[];
}>;

export type ProductViewModel = Readonly<{
  slug: string;
  name: string;
  media: StorefrontProductMedia;
  collections: readonly Readonly<{ slug: string; title: string }>[];
  editorial: ProductEditorial;
  options: readonly StorefrontProjectionOption[];
  productLevelOptions: readonly StorefrontProjectionOption[];
  deepLinkedSelection: DeepLinkedVariantSelection | null;
  /** Which gallery image to open on, before the shopper touches anything. */
  initialGalleryIndex: number;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  relatedCards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
}>;

export type ProductViewModelInput = Readonly<{
  slug: string;
  name: string;
  media: StorefrontProductMedia;
  collections: readonly Readonly<{ slug: string; title: string }>[];
  editorialDescription: string | null;
  material: string | null;
  craftDetails: readonly string[];
  sizeGuide: string | null;
  careInstructions: string | null;
  options: readonly StorefrontProjectionOption[];
  productLevelOptions: readonly StorefrontProjectionOption[];
  deepLinkedSelection: DeepLinkedVariantSelection | null;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  relatedProducts: readonly RelatedProduct[];
  relatedPricingRule?: StorefrontPricingRule;
  relatedSelectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

/**
 * Where a `?variant=` deep link opens the gallery.
 *
 * A variant the product's map does not cover opens on the first image rather than on nothing: the
 * link still addressed a real variant, and the panel preselects it either way.
 */
export function resolveInitialGalleryIndex(
  deepLinkedSelection: DeepLinkedVariantSelection | null,
  galleryIndexByVariantId: Readonly<Record<string, number>>,
): number {
  if (deepLinkedSelection === null) return 0;
  return galleryIndexByVariantId[deepLinkedSelection.variantId] ?? 0;
}

export function resolveProductMappedSizeGuide(
  sizeGuideId: string | null,
): ProductMappedSizeGuide | null {
  if (!isApprovedSizeGuideId(sizeGuideId)) return null;

  const publicGuide = buildSizeGuideViewModel();
  const chart = publicGuide.charts.find((candidate) => candidate.id === sizeGuideId);
  if (!chart) return null;

  return Object.freeze({
    id: sizeGuideId,
    chart,
    tolerance: publicGuide.tolerance,
    circumferenceSemanticsNote: publicGuide.circumferenceSemanticsNote,
    guidanceNote: publicGuide.guidanceNote,
  });
}

export function buildProductViewModel(input: ProductViewModelInput): ProductViewModel {
  const craftDetails = input.craftDetails.filter((detail) => detail.trim().length > 0);
  const sizeGuide = resolveProductMappedSizeGuide(input.sizeGuide);

  return Object.freeze({
    slug: input.slug,
    name: input.name,
    media: input.media,
    collections: Object.freeze([...input.collections]),
    editorial: Object.freeze({
      description: input.editorialDescription,
      material: input.material,
      craftDetails: Object.freeze(craftDetails),
      sizeGuide,
      careInstructions: input.careInstructions,
      hasNotes:
        input.material !== null
        || craftDetails.length > 0
        || input.careInstructions !== null,
    }),
    options: input.options,
    productLevelOptions: input.productLevelOptions,
    deepLinkedSelection: input.deepLinkedSelection,
    initialGalleryIndex: resolveInitialGalleryIndex(
      input.deepLinkedSelection,
      input.galleryIndexByVariantId,
    ),
    galleryIndexByVariantId: input.galleryIndexByVariantId,
    relatedCards: Object.freeze(
      input.relatedProducts.map((related) =>
        Object.freeze({
          id: related.id,
          model: buildProductCardModel({
            slug: related.slug,
            name: related.name,
            media: related.media,
            variants: related.variants,
            pricingRule: input.relatedPricingRule,
            selectEvent: input.relatedSelectEventBySlug.get(related.slug) ?? null,
          }),
        }),
      ),
    ),
  });
}
