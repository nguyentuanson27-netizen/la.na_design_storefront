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
import { createStorefrontRoute } from "@/routes/factory";
import { buildShopMetadata } from "@/routes/metadata/shop";
import { loadShopRoute, type ShopRouteProps } from "@/routes/shop";
import type { ShopViewModel } from "@/routes/shop-model";

/**
 * Markup only. The query parsing, the catalog page, the facets, the tracking and the refresh window
 * all live in `@/routes/shop`; the shell mounts what the loader sealed.
 *
 * The chrome is the shared listing chrome, but the controls are this route's own. `/shop` is
 * `Tất cả sản phẩm` with a free-text query and a collection facet, which the category PLP's filter
 * panel has no notion of -- that panel builds every href from a taxonomy key. Sharing it would mean
 * changing what `/shop` can be asked, so the form below stays a plain GET over this route's own
 * parameters and only the presentation is shared.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

const controlClassName =
  "min-h-11 w-full border-b border-[#3B2219]/30 bg-transparent px-0 py-2 text-sm text-[#2A1810] outline-none focus-visible:border-[#3B2219] focus-visible:outline-2 focus-visible:outline-offset-4";

const fieldLabelClassName = "text-xs font-semibold uppercase tracking-wider text-[#70584B]";

const linkClassName =
  "inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline-offset-4 transition-colors hover:text-[#2A1810] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: ShopViewModel) {
  const { discovery } = data;

  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Cửa hàng" }]} />
      <ListingHeader eyebrow="Tất cả sản phẩm" title="Cửa hàng">
        <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">
          Dùng tìm kiếm và bộ lọc để khám phá sản phẩm.{" "}
          {/* Kept on one source line: the copy inventory reads this promise as a whole string. */}
          Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.
        </p>
      </ListingHeader>

      <section
        className="mt-8 border-b border-[#3B2219]/15 pb-8"
        aria-labelledby="shop-discovery-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2
            id="shop-discovery-title"
            className="text-xs font-semibold uppercase tracking-wider text-[#70584B]"
          >
            Bộ lọc
          </h2>
          {data.filtered ? (
            <Link className={linkClassName} href="/shop">
              Xóa bộ lọc
            </Link>
          ) : null}
        </div>

        <form className="mt-6 grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-4" method="get">
          <label className="block sm:col-span-2">
            <span className={fieldLabelClassName}>Tìm sản phẩm</span>
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
            <span className={fieldLabelClassName}>Bộ sưu tập</span>
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
            <span className={fieldLabelClassName}>Sắp xếp</span>
            <select className={controlClassName} defaultValue={discovery.sort} name="sort">
              <option value="name-asc">Tên A–Z</option>
              <option value="name-desc">Tên Z–A</option>
              <option value="price-asc">Giá thấp → cao</option>
              <option value="price-desc">Giá cao → thấp</option>
            </select>
          </label>

          <label className="block">
            <span className={fieldLabelClassName}>Màu</span>
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
            <span className={fieldLabelClassName}>Kích cỡ</span>
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
            <span className={fieldLabelClassName}>Giá tối thiểu</span>
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
            <span className={fieldLabelClassName}>Giá tối đa</span>
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
            <span className={fieldLabelClassName}>Chỉ còn hàng</span>
          </label>

          <div className="flex items-end sm:col-span-2 lg:col-span-1">
            <button
              className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-[#3B2219] bg-[#3B2219] px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[#FAF7F2] transition-colors hover:bg-[#2A1810] focus-visible:outline-2 focus-visible:outline-offset-4"
              type="submit"
            >
              Áp dụng
            </button>
          </div>
        </form>
      </section>

      {data.totalCount === 0 ? (
        <ListingEmptyState
          titleId="shop-empty-title"
          eyebrow={data.filtered ? "Không tìm thấy" : "Sản phẩm hiện tại"}
          title={data.filtered ? "Không có sản phẩm phù hợp." : "Chưa có sản phẩm đang mở bán."}
          copy={
            data.filtered
              ? "Thử bỏ bớt bộ lọc hoặc xem lại tất cả sản phẩm."
              : "Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để mua trên website."
          }
          action={data.filtered ? { href: "/shop", label: "Xem tất cả sản phẩm" } : undefined}
        />
      ) : (
        <section className="mt-8" aria-labelledby="shop-products-title">
          <h2 id="shop-products-title" className="sr-only">
            Sản phẩm hiện tại
          </h2>
          <ListingResultCount>{data.totalCount} sản phẩm</ListingResultCount>
          <div className="mt-8">
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
            label="Phân trang sản phẩm"
            page={data.page}
            totalPages={data.totalPages}
            previousHref={data.previousHref}
            nextHref={data.nextHref}
          />
        </section>
      )}
    </ListingShell>
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
