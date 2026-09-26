import Image from "next/image";

import { ArtDirectedHeroImage } from "@/components/brand/art-directed-hero-image";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { CollectionFilterPanel } from "@/components/brand/collection-filter-panel";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingPagination,
  ListingProductGrid,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { loadCollectionRoute, type CollectionRouteProps } from "@/routes/collection";
import type { CollectionViewModel } from "@/routes/collection-model";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCollectionMetadata } from "@/routes/metadata/collection";

/**
 * Markup only. The definition, its page of products, the filter links, the breadcrumb graph and the
 * refresh window all live in `@/routes/collection`.
 *
 * The editorial half -- hero, gallery, video -- is this collection's own and stays. The
 * listing half underneath now draws the same chrome as every other listing instead of keeping a
 * second one. The loader still owns every canonical sort/filter href; the client panel consumes
 * those hrefs for its sort options and size links without re-deriving route state.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: CollectionViewModel) {
  const { editorial } = data;

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
        >
          <ArtDirectedHeroImage
            desktopSrc={editorial.heroImage}
            mobileSrc={editorial.heroImageMobile}
            alt={data.title}
            preload
          />
        </section>
      ) : null}

      <ListingShell>
        <ListingBreadcrumbs
          className="sr-only"
          items={[
            { label: "Trang chủ", href: "/" },
            { label: "Bộ sưu tập", href: "/collections" },
            { label: data.title },
          ]}
        />
        {/* Title only: the owner removed the story line and the buyer notice from this header. The
            story still feeds the page's metadata; the notice stays on `/shop`. */}
        <ListingHeader title={data.title} />

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
          className="mt-12"
          aria-label="Điều khiển bộ sưu tập"
        >
          <CollectionFilterPanel
            totalCount={data.totalCount}
            sortOptions={data.sortOptions}
            sizeOptions={data.sizeOptions}
            clearFilterHref={data.clearFilterHref}
            filtered={data.filtered}
          />
        </section>

        {data.totalCount === 0 ? (
          <ListingEmptyState
            titleId="collection-empty-title"
            eyebrow={data.filtered ? "Không tìm thấy" : "Bộ sưu tập hiện tại"}
            title={data.filtered ? "Không có sản phẩm phù hợp." : "Bộ sưu tập này chưa có sản phẩm."}
            copy={
              data.filtered
                ? "Thử chọn kích cỡ khác hoặc xem lại tất cả sản phẩm trong bộ sưu tập."
                : "Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập."
            }
            action={
              data.filtered
                ? { href: data.clearFilterHref, label: "Xem tất cả kích cỡ" }
                : undefined
            }
          />
        ) : (
          <section className="mt-8" aria-labelledby="collection-products-title">
            <h2 id="collection-products-title" className="sr-only">
              Sản phẩm
            </h2>
            <div>
              <ListingProductGrid>
                {data.cards.map((card, index) => (
                  <ProductCard
                    key={card.id}
                    model={card.model}
                    tone={tones[(data.toneOffset + index) % tones.length]!}
                  />
                ))}
              </ListingProductGrid>
            </div>
            <ListingPagination
              label="Phân trang bộ sưu tập"
              page={data.page}
              totalPages={data.totalPages}
              previousHref={data.previousHref}
              nextHref={data.nextHref}
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
