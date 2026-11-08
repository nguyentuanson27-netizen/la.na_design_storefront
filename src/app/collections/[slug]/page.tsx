import Image from "next/image";

import { ArtDirectedHeroImage } from "@/components/brand/art-directed-hero-image";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { PlpFilterPanel } from "@/components/brand/plp-filter-panel";
import { PlpInfiniteGrid } from "@/components/brand/plp-infinite-grid";
import { loadCollectionRoute, type CollectionRouteProps } from "@/routes/collection";
import { COLLECTION_PRODUCTS_ANCHOR, type CollectionViewModel } from "@/routes/collection-model";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCollectionMetadata } from "@/routes/metadata/collection";

/**
 * Markup only. The definition, its page of products, the filter links, the breadcrumb graph and the
 * refresh window all live in `@/routes/collection`.
 *
 * The editorial half -- hero, gallery, video -- is this collection's own and stays. The listing
 * half underneath is the category listing's: the same filter panel (size, price, "Còn hàng", "Sale",
 * sort) and the same infinite grid, paging through the collection's own server action. Its links
 * are written against `/collections/<slug>` in the category vocabulary, and the grid keeps a
 * crawlable next-page link for a reader without script.
 */

function render(data: CollectionViewModel) {
  const { editorial } = data;
  // Where `#san-pham` lands: the title when the product controls follow it directly, otherwise the
  // controls themselves, so a tall gallery or video never sits between the shopper and the grid.
  // The homepage hero's MUA NGAY link and `homepage-hero.spec.ts` rely on this landing, so the grid
  // below does not take the anchor itself (`anchor={false}`).
  const productsAnchorOnTitle = !editorial.video && editorial.gallery.length === 0;

  return (
    <>
      {/* The hero is the page's first full-bleed surface, not an image inside the container: the
          header renders transparent over it and turns cream past the scroll threshold, which is
          what `data-header-overlay-hero` declares. Putting it back under the heading -- which is
          what a naive merge of the shared listing chrome does -- silently returns it to a
          constrained 16:9 block and drops the overlay. `collection-landing.spec.ts` pins the
          hero-first order and the shared chrome together so the two cannot be reconciled by
          losing one of them. */}
      {editorial.heroImage ? (
        <section
          className="collection-page-hero"
          aria-label={`Ảnh bìa bộ sưu tập ${data.title}`}
          data-header-overlay-hero=""
          data-collection-hero=""
        >
          <ArtDirectedHeroImage
            desktopSrc={editorial.heroImage}
            mobileSrc={editorial.heroImageMobile}
            alt={data.title}
            preload
          />
          {/* The hero fills the first screen, so on a phone nothing else says the products are
              below it. A plain in-page link, in the homepage banner's underlined vocabulary, to the
              same anchor the homepage hero's CTA lands on. */}
          <div aria-hidden="true" className="collection-page-hero__scrim" />
          <a className="collection-page-hero__cue" href={`#${COLLECTION_PRODUCTS_ANCHOR}`}>
            <span className="collection-page-hero__cue-label">Xem sản phẩm</span>
            <span aria-hidden="true" className="collection-page-hero__cue-arrow">
              ↓
            </span>
          </a>
        </section>
      ) : null}

      <ListingShell>
        <ListingBreadcrumbs
          items={[
            { label: "Trang chủ", href: "/" },
            { label: "Bộ sưu tập", href: "/collections" },
            { label: data.title },
          ]}
        />
        {/* Title only: the owner removed the story line and the buyer notice from this header. The
            story still feeds the page's metadata; the notice stays on `/shop`. */}
        <div
          id={productsAnchorOnTitle ? COLLECTION_PRODUCTS_ANCHOR : "bo-suu-tap"}
          className="collection-products-anchor"
        >
          {productsAnchorOnTitle ? (
            <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
          ) : null}
          <ListingHeader title={data.title} />
        </div>

        {editorial.video ? (
          <div className="mt-12">
            {/* Muted, loopless and controllable: an editorial panel, not an autoplaying advert. */}
            <video
              className="w-full bg-black"
              controls
              playsInline
              preload="none"
              poster={editorial.video.poster ?? undefined}
              src={editorial.video.src}
            />
          </div>
        ) : null}

        {editorial.gallery.length > 0 ? (
          <section
            className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={`Hình ảnh bộ sưu tập ${data.title}`}
          >
            {editorial.gallery.map((url, index) => (
              <div key={url} className="relative aspect-[3/4] overflow-hidden bg-[var(--stone)]">
                <Image
                  src={url}
                  alt={`${data.title} — Ảnh ${index + 1}`}
                  fill
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  className="object-cover"
                />
              </div>
            ))}
          </section>
        ) : null}

        <section
          id={productsAnchorOnTitle ? "bo-loc" : COLLECTION_PRODUCTS_ANCHOR}
          className="collection-products-anchor mt-6 md:mt-12"
          aria-label="Điều khiển bộ sưu tập"
        >
          {productsAnchorOnTitle ? null : (
            <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
          )}
          <PlpFilterPanel
            categoryPath={data.basePath}
            totalCount={data.totalCount}
            availableSizes={data.availableSizes}
            saleAvailable={data.saleAvailable}
            activeFilters={data.filters}
          />
        </section>

        {data.totalCount === 0 && !data.filtered ? (
          <ListingEmptyState
            titleId="collection-empty-title"
            eyebrow="Bộ sưu tập hiện tại"
            title="Bộ sưu tập này chưa có sản phẩm."
            copy="Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập."
          />
        ) : (
          <section className="mt-4" aria-labelledby="collection-products-title">
            <h2 id="collection-products-title" className="sr-only">
              Sản phẩm
            </h2>
            {/* The anchors already sit above, on the title or the controls; the grid must not repeat them. */}
            <PlpInfiniteGrid
              initialProducts={data.cards.map((card) => card.model)}
              totalCount={data.totalCount}
              totalPages={data.totalPages}
              initialPage={data.page}
              source={{ kind: "collection", slug: data.slug }}
              clearHref={data.basePath}
              activeFilters={data.filters}
              hasNext={data.hasNext}
              nextHref={data.nextHref}
              nextCursor={data.nextCursor}
              toneOffset={data.toneOffset}
              emptyStateAnchors={false}
            />
          </section>
        )}
      </ListingShell>
    </>
  );
}

const route = createStorefrontRoute<CollectionRouteProps, CollectionViewModel>({
  load: loadCollectionRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildCollectionMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
