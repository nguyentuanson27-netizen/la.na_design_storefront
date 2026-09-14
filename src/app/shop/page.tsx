import Link from "next/link";

import { BRAND } from "@/brand";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { createStorefrontRoute } from "@/routes/factory";
import { buildShopMetadata } from "@/routes/metadata/shop";
import { loadShopRoute, type ShopRouteProps } from "@/routes/shop";
import type { ShopViewModel } from "@/routes/shop-model";

/**
 * Markup only. The query parsing, the catalog page, the facets, the tracking and the refresh window
 * all live in `@/routes/shop`; the shell mounts what the loader sealed.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

const controlClassName =
  "min-h-11 w-full border-b border-black/30 bg-transparent px-0 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

const linkClassName =
  "inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: ShopViewModel) {
  const { discovery } = data;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">{BRAND.identity.name} / Cửa hàng</p>
      <h1 className="mt-4 max-w-5xl text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        CỬA HÀNG
      </h1>
      <div className="mt-12 grid gap-8 border-t border-black/20 pt-8 md:grid-cols-2">
        <p className="max-w-xl font-serif text-2xl leading-snug md:text-3xl">
          Phom dáng thư thái, đường nét gọn và bảng màu trung tính cho nhịp sống hằng ngày.
        </p>
        <p className="max-w-lg text-sm leading-6 text-black/70 md:justify-self-end">
          Dùng tìm kiếm và bộ lọc để khám phá sản phẩm. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.
        </p>
      </div>

      <section className="mt-14 border-y border-black/20 py-8" aria-labelledby="shop-discovery-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Khám phá</p>
            <h2 id="shop-discovery-title" className="mt-2 font-serif text-3xl tracking-[-0.03em]">
              Khám phá sản phẩm
            </h2>
          </div>
          {data.filtered ? (
            <Link className={linkClassName} href="/shop">
              Xóa bộ lọc
            </Link>
          ) : null}
        </div>

        <form className="mt-8 grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-4" method="get">
          <label className="block sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Tìm sản phẩm</span>
            <input
              className={controlClassName}
              defaultValue={discovery.query ?? ""}
              maxLength={data.limits.query}
              name="q"
              placeholder="Tên sản phẩm"
              type="search"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Bộ sưu tập</span>
            <select className={controlClassName} defaultValue={discovery.collection ?? ""} name="collection">
              <option value="">Tất cả</option>
              {data.collectionFacets.map((collection) => (
                <option key={collection.value} value={collection.value}>
                  {collection.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Sắp xếp</span>
            <select className={controlClassName} defaultValue={discovery.sort} name="sort">
              <option value="name-asc">Tên A–Z</option>
              <option value="name-desc">Tên Z–A</option>
              <option value="price-asc">Giá thấp → cao</option>
              <option value="price-desc">Giá cao → thấp</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Màu</span>
            <select className={controlClassName} defaultValue={discovery.color ?? ""} name="color">
              <option value="">Tất cả</option>
              {data.colorFacets.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Kích cỡ</span>
            <select className={controlClassName} defaultValue={discovery.size ?? ""} name="size">
              <option value="">Tất cả</option>
              {data.sizeFacets.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Giá tối thiểu</span>
            <input
              className={controlClassName}
              defaultValue={discovery.minPriceVnd ?? ""}
              inputMode="numeric"
              max={data.limits.priceVnd}
              min={0}
              name="minPrice"
              placeholder="VND"
              step={1000}
              type="number"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Giá tối đa</span>
            <input
              className={controlClassName}
              defaultValue={discovery.maxPriceVnd ?? ""}
              inputMode="numeric"
              max={data.limits.priceVnd}
              min={0}
              name="maxPrice"
              placeholder="VND"
              step={1000}
              type="number"
            />
          </label>

          <label className="flex min-h-11 items-center gap-3 sm:col-span-2 lg:col-span-1">
            <input
              defaultChecked={discovery.availability === "in-stock"}
              name="availability"
              type="checkbox"
              value="in-stock"
            />
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Chỉ còn hàng</span>
          </label>

          <div className="flex items-end sm:col-span-2 lg:col-span-1">
            <button
              className="inline-flex min-h-11 w-full items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
              type="submit"
            >
              Áp dụng
            </button>
          </div>
        </form>
      </section>

      {data.totalCount === 0 ? (
        <section className="mt-16 border-t border-black/20 py-16" aria-labelledby="shop-empty-title">
          <p className="eyebrow">{data.filtered ? "Không tìm thấy" : "Sản phẩm hiện tại"}</p>
          <h2 id="shop-empty-title" className="mt-4 max-w-2xl font-serif text-3xl leading-tight md:text-5xl">
            {data.filtered ? "Không có sản phẩm phù hợp." : "Chưa có sản phẩm đang mở bán."}
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-black/65">
            {data.filtered
              ? "Thử bỏ bớt bộ lọc hoặc xem lại tất cả sản phẩm."
              : "Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để mua trên website."}
          </p>
          {data.filtered ? (
            <Link className={`mt-6 ${linkClassName}`} href="/shop">
              Xem tất cả sản phẩm →
            </Link>
          ) : null}
        </section>
      ) : (
        <section className="mt-16" aria-labelledby="shop-products-title">
          <div className="section-heading-row border-t border-black/20 pt-5">
            <h2 id="shop-products-title">Sản phẩm hiện tại</h2>
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
              aria-label="Phân trang sản phẩm"
            >
              {data.previousHref ? (
                <Link
                  className={`${linkClassName} focus-visible:outline focus-visible:outline-black`}
                  href={data.previousHref}
                  rel="prev"
                >
                  ← Trang trước
                </Link>
              ) : (
                <span aria-hidden="true" />
              )}
              {data.nextHref ? (
                <Link
                  className={`${linkClassName} focus-visible:outline focus-visible:outline-black`}
                  href={data.nextHref}
                  rel="next"
                >
                  Trang sau →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </div>
  );
}

const route = createStorefrontRoute<ShopRouteProps, ShopViewModel>({
  load: loadShopRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildShopMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
