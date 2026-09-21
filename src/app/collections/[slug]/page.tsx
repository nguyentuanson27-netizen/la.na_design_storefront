import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { loadCollectionRoute, type CollectionRouteProps } from "@/routes/collection";
import type { CollectionViewModel } from "@/routes/collection-model";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCollectionMetadata } from "@/routes/metadata/collection";

/**
 * Markup only. The definition, its page of products, the filter links, the breadcrumb graph and the
 * refresh window all live in `@/routes/collection`.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

const optionLinkClassName =
  "inline-flex min-h-11 items-center border border-black/25 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-colors hover:border-black hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4";
const activeOptionLinkClassName = "border-black bg-black/10";
const textLinkClassName =
  "inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4";

function optionClass(active: boolean): string {
  return `${optionLinkClassName}${active ? ` ${activeOptionLinkClassName}` : ""}`;
}

function render(data: CollectionViewModel) {
  const { editorial } = data;

  return (
    <>
      {editorial.heroImage ? (
        <section
          className="collection-page-hero"
          aria-label={`Ảnh bìa bộ sưu tập ${data.title}`}
          data-header-overlay-hero
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

      <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-10 md:py-16">
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-black/60">
          <li><Link className="hover:underline" href="/">Trang chủ</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link className="hover:underline" href="/collections">Bộ sưu tập</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black">{data.title}</li>
        </ol>
      </nav>
      <p className="eyebrow mt-6">{BRAND.identity.name} / Bộ sưu tập</p>
      <h1 className="mt-4 max-w-6xl break-words text-[clamp(2.5rem,8vw,7rem)] font-semibold leading-[0.88] tracking-[-0.05em]">
        {data.title}
      </h1>

      <div className="mt-10 grid gap-8 border-t border-black/20 pt-8 md:grid-cols-2">
        <p className="max-w-2xl break-words font-serif text-2xl leading-snug md:text-3xl">
          {editorial.story}
        </p>
        <p className="max-w-lg text-sm leading-6 text-black/65 md:justify-self-end">
          Khám phá các sản phẩm trong bộ sưu tập này. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.
        </p>
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
        <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={`Hình ảnh bộ sưu tập ${data.title}`}>
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

      <section className="mt-12 grid gap-8 border-y border-black/20 py-6 md:grid-cols-2" aria-label="Điều khiển bộ sưu tập">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.13em]">Sắp xếp</p>
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
          <p className="text-xs font-semibold uppercase tracking-[0.13em]">Kích cỡ</p>
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
        <section className="mt-16 border-t border-black/20 py-16" aria-labelledby="collection-empty-title">
          <p className="eyebrow">{data.filtered ? "Không tìm thấy" : "Bộ sưu tập hiện tại"}</p>
          <h2 id="collection-empty-title" className="mt-4 max-w-2xl font-serif text-3xl leading-tight md:text-5xl">
            {data.filtered ? "Không có sản phẩm phù hợp." : "Bộ sưu tập này chưa có sản phẩm."}
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-black/65">
            {data.filtered
              ? "Thử chọn kích cỡ khác hoặc xem lại tất cả sản phẩm trong bộ sưu tập."
              : "Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập."}
          </p>
          {data.filtered ? (
            <Link className={`mt-6 ${textLinkClassName}`} href={data.clearFilterHref}>
              Xem tất cả kích cỡ →
            </Link>
          ) : null}
        </section>
      ) : (
        <section className="mt-16" aria-labelledby="collection-products-title">
          <div className="section-heading-row border-t border-black/20 pt-5">
            <h2 id="collection-products-title">Sản phẩm</h2>
            <p className="eyebrow">
              {data.totalCount} sản phẩm · Trang {data.page}/{data.totalPages}
            </p>
          </div>
          <div className="product-grid">
            {data.cards.map((card, index) => (
              <ProductCard
                key={card.id}
                model={card.model}
                tone={tones[(data.toneOffset + index) % tones.length]!}
              />
            ))}
          </div>

          {data.totalPages > 1 ? (
            <nav
              className="mt-12 flex items-center justify-between gap-4 border-t border-black/20 pt-6"
              aria-label="Phân trang bộ sưu tập"
            >
              {data.previousHref ? (
                <Link className={textLinkClassName} href={data.previousHref} rel="prev">
                  ← Trang trước
                </Link>
              ) : (
                <span aria-hidden="true" />
              )}
              {data.nextHref ? (
                <Link className={textLinkClassName} href={data.nextHref} rel="next">
                  Trang sau →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
      </div>
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
