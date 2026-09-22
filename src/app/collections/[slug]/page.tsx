import Image from "next/image";
import Link from "next/link";

import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingPagination,
  ListingProductGrid,
  ListingResultCount,
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
 * The editorial half -- hero, story, gallery, video -- is this collection's own and stays. The
 * listing half underneath now draws the same chrome as every other listing instead of keeping a
 * second one. The sort and size controls remain link-based because the loader builds their hrefs
 * from the collection slug; only their styling is aligned.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

// `listing-pill` carries the label colour; see the note on it in globals.css.
const optionLinkClassName =
  "listing-pill inline-flex min-h-11 items-center rounded-full border border-[#3B2219]/20 px-4 py-2 text-xs font-medium uppercase tracking-wider transition hover:border-[#2A1810] hover:bg-[#2A1810] focus-visible:outline-2 focus-visible:outline-offset-4";
const activeOptionLinkClassName = "border-[#3B2219] bg-[#3B2219]";

function optionClass(active: boolean): string {
  return `${optionLinkClassName}${active ? ` ${activeOptionLinkClassName}` : ""}`;
}

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
          <Image
            src={editorial.heroImage}
            alt={data.title}
            fill
            preload
            sizes="100vw"
            className="object-cover"
          />
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
        <ListingHeader eyebrow="Bộ sưu tập" title={data.title}>
          <p className="mt-3 max-w-2xl break-words font-serif text-xl leading-snug text-[#2A1810] md:text-2xl">
            {editorial.story}
          </p>
          {/* Buyer information, not decoration: it sets the expectation that the figures on the
              cards are re-checked at purchase, which is the same promise `/shop` makes. Kept on one
              source line because the copy inventory reads the promise as a whole string. */}
          <p className="mt-3 max-w-xl text-sm leading-6 text-[#3B2219]/70">
            Khám phá các sản phẩm trong bộ sưu tập này. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.
          </p>
        </ListingHeader>

        {editorial.video ? (
          <div className="mt-6">
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
            className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
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
          className="mt-6 grid gap-6 border-b border-[#3B2219]/15 pb-5 md:grid-cols-2"
          aria-label="Điều khiển bộ sưu tập"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#70584B]">Sắp xếp</p>
            <nav aria-label="Sắp xếp bộ sưu tập" className="mt-3 flex flex-wrap gap-2">
              {data.sortOptions.map((option) => (
                <Link
                  aria-current={option.active ? "true" : undefined}
                  className={optionClass(option.active)}
                  href={option.href}
                  key={option.value}
                >
                  {option.label}
                </Link>
              ))}
            </nav>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#70584B]">Kích cỡ</p>
            <nav aria-label="Lọc theo kích cỡ" className="mt-3 flex flex-wrap gap-2">
              {data.sizeOptions.map((option) => (
                <Link
                  aria-current={option.active ? "true" : undefined}
                  className={optionClass(option.active)}
                  href={option.href}
                  key={option.value ?? "all"}
                >
                  {option.label}
                </Link>
              ))}
            </nav>
          </div>
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
          <section className="mt-5" aria-labelledby="collection-products-title">
            <h2 id="collection-products-title" className="sr-only">
              Sản phẩm
            </h2>
            <ListingResultCount>{data.totalCount} sản phẩm</ListingResultCount>
            <div className="mt-4">
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
