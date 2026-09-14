import type { StorefrontProductMedia, TrustedProductImage } from "../commerce/product-media.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";

/**
 * Everything the home route decides, as one pure function.
 *
 * The loader fetches; this turns what came back into what the page renders. It is separate from
 * `home.ts` because that file reaches the catalog runtime and `next/server`, neither of which the
 * domain test runner can load -- and the editorial picks below are the part worth testing, because
 * their fallback chain is the kind of thing that silently degrades to a blank panel.
 *
 * No pricing is decided here: every card comes from `buildProductCardModel`, which is where the
 * money rules live.
 */

/** The fields of a catalog product this route actually reads. */
export type HomeProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  media?: StorefrontProductMedia | null;
  variants: StorefrontVariantFacts[];
}>;

export type HomeCollectionLink = Readonly<{ slug: string; title: string }>;

/**
 * One editorial panel: the photo and the product it came from, so markup can fall back to the
 * product's name when the image carries no alt text of its own. `null` when no product on the page
 * has trusted photography.
 */
export type HomeEditorialPanel = Readonly<{
  image: TrustedProductImage;
  productName: string;
}> | null;

export type HomeCard = Readonly<{ id: string; model: ProductCardModel }>;

export type HomeViewModel = Readonly<{
  cards: readonly HomeCard[];
  hero: HomeEditorialPanel;
  lookbookLarge: HomeEditorialPanel;
  lookbookSmall: HomeEditorialPanel;
  collections: readonly HomeCollectionLink[];
}>;

export type HomeViewModelInput = Readonly<{
  products: readonly HomeProduct[];
  pricingRule?: StorefrontPricingRule;
  collections: readonly HomeCollectionLink[];
  /** Prebuilt on the server, so a click handler never reassembles a payload from the DOM. */
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

function panel(product: HomeProduct | undefined): HomeEditorialPanel {
  const image = product?.media?.primary;
  return image ? Object.freeze({ image, productName: product!.name }) : null;
}

export function buildHomeViewModel({
  products,
  pricingRule,
  collections,
  selectEventBySlug,
}: HomeViewModelInput): HomeViewModel {
  // Only products with trusted photography can fill an editorial panel. The rest still get cards:
  // a card without a photo has its own fallback, but a full-bleed panel without one is a blank wall.
  const photographed = products.filter((product) => product.media?.primary);

  return Object.freeze({
    cards: Object.freeze(
      products.map((product) =>
        Object.freeze({
          id: product.id,
          model: buildProductCardModel({
            slug: product.slug,
            name: product.name,
            media: product.media,
            variants: product.variants,
            pricingRule,
            selectEvent: selectEventBySlug.get(product.slug) ?? null,
          }),
        }),
      ),
    ),
    // Each panel falls back to the one above it, so a page with a single photographed product shows
    // that photo in all three rather than leaving two panels empty.
    hero: panel(photographed[0]),
    lookbookLarge: panel(photographed[1] ?? photographed[0]),
    lookbookSmall: panel(photographed[2] ?? photographed[1] ?? photographed[0]),
    collections: Object.freeze([...collections]),
  });
}
