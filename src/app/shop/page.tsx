import Link from "next/link";

import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { ShopActiveFilters, ShopMobileDrawer } from "@/components/brand/shop-controls";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingPagination,
  ListingProductGrid,
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
 * `Tất cả sản phẩm` with a free-text query and a collection facet, now fully aligned with the
 * Category PLP filter panel standard for both Desktop and Mobile.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: ShopViewModel) {
  const { discovery } = data;

  let activeFilterCount = 0;
  if (discovery.query && discovery.query.trim()) activeFilterCount += 1;
  if (discovery.collection) activeFilterCount += 1;
  if (discovery.color) activeFilterCount += 1;
  if (discovery.size) activeFilterCount += 1;
  if (discovery.availability === "in-stock") activeFilterCount += 1;
  if (discovery.minPriceVnd !== null || discovery.maxPriceVnd !== null) activeFilterCount += 1;

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
        className="mt-8 border-b border-[#3B2219]/15 pb-6"
        aria-labelledby="shop-discovery-title"
      >
        <h2 id="shop-discovery-title" className="sr-only">
          Bộ lọc cửa hàng
        </h2>

        {/* Mobile: search, sort and drawer filters are one GET form authority. */}
        <form method="get" action="/shop" className="md:hidden">
          <div className="flex flex-col gap-4">
            <div className="text-xs uppercase tracking-wider text-[#70584B] font-sans">
              <span>{data.totalCount} sản phẩm</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="relative flex min-w-[200px] flex-1 items-center">
                <span className="sr-only">Tìm sản phẩm</span>
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[#3B2219]/40">
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <input
                  type="search"
                  name="q"
                  aria-label="Tìm sản phẩm"
                  placeholder="Tìm sản phẩm…"
                  defaultValue={discovery.query ?? ""}
                  maxLength={data.limits.query}
                  className="w-full rounded-full border border-[#3B2219]/20 bg-transparent py-1.5 pl-8 pr-3 text-xs text-[#2A1810] placeholder:text-[#3B2219]/40 focus-visible:outline-2 focus-visible:outline-[#3B2219]"
                />
              </label>

              <ShopMobileDrawer
                limits={data.limits}
                discovery={discovery}
                collectionFacets={data.collectionFacets}
                colorFacets={data.colorFacets}
                sizeFacets={data.sizeFacets}
                activeFilterCount={activeFilterCount}
              />

              <select
                id="shop-sort-select-mobile"
                name="sort"
                aria-label="Sắp xếp"
                defaultValue={discovery.sort}
                className="rounded border border-[#3B2219]/20 bg-transparent px-3 py-1.5 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
              >
                <option value="name-asc">Tên A–Z</option>
                <option value="name-desc">Tên Z–A</option>
                <option value="price-asc">Giá thấp → cao</option>
                <option value="price-desc">Giá cao → thấp</option>
              </select>
            </div>
          </div>
        </form>

        {/* Desktop keeps the same native GET semantics without rendering mobile duplicate fields. */}
        <form method="get" action="/shop" className="hidden md:block">
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs uppercase tracking-wider text-[#70584B] font-sans">
              <span>{data.totalCount} sản phẩm</span>
            </div>

            <div className="flex items-center gap-4">
              <label className="relative flex w-64 items-center lg:w-72">
                <span className="sr-only">Tìm sản phẩm</span>
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[#3B2219]/40">
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <input
                  type="search"
                  name="q"
                  aria-label="Tìm sản phẩm"
                  placeholder="Tìm sản phẩm…"
                  defaultValue={discovery.query ?? ""}
                  maxLength={data.limits.query}
                  className="w-full rounded-full border border-[#3B2219]/20 bg-transparent py-1.5 pl-8 pr-3 text-xs text-[#2A1810] placeholder:text-[#3B2219]/40 focus-visible:outline-2 focus-visible:outline-[#3B2219]"
                />
              </label>

              <div className="flex items-center gap-2">
                <label
                  htmlFor="shop-sort-select-desktop"
                  className="text-xs uppercase tracking-wider text-[#3B2219]/70"
                >
                  Sắp xếp:
                </label>
                <select
                  id="shop-sort-select-desktop"
                  name="sort"
                  aria-label="Sắp xếp"
                  defaultValue={discovery.sort}
                  className="rounded border border-[#3B2219]/20 bg-transparent px-3 py-1.5 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
                >
                  <option value="name-asc">Tên A–Z</option>
                  <option value="name-desc">Tên Z–A</option>
                  <option value="price-asc">Giá thấp → cao</option>
                  <option value="price-desc">Giá cao → thấp</option>
                </select>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-[#3B2219]">
            <span className="font-semibold uppercase tracking-wider text-[#70584B]">Bộ lọc</span>

            <label className="inline-flex items-center gap-1.5 rounded-md border border-[#3B2219]/25 px-3 py-1 font-medium cursor-pointer transition hover:border-[#3B2219] text-[#3B2219]">
              <input
                type="checkbox"
                name="availability"
                value="in-stock"
                defaultChecked={discovery.availability === "in-stock"}
                aria-label="Chỉ còn hàng"
                className="h-3.5 w-3.5 rounded border-[#3B2219]/30 accent-[#3B2219]"
              />
              <span>Chỉ còn hàng</span>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wider text-[#70584B]">Bộ sưu tập</span>
              <select
                name="collection"
                aria-label="Bộ sưu tập"
                defaultValue={discovery.collection ?? ""}
                className="rounded border border-[#3B2219]/20 bg-transparent px-2.5 py-1 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
              >
                <option value="">Tất cả</option>
                {data.collectionFacets.map((col) => (
                  <option key={col.value} value={col.value}>
                    {col.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wider text-[#70584B]">Kích cỡ</span>
              <select
                name="size"
                aria-label="Kích cỡ"
                defaultValue={discovery.size ?? ""}
                className="rounded border border-[#3B2219]/20 bg-transparent px-2.5 py-1 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
              >
                <option value="">Tất cả</option>
                {data.sizeFacets.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wider text-[#70584B]">Màu</span>
              <select
                name="color"
                aria-label="Màu"
                defaultValue={discovery.color ?? ""}
                className="rounded border border-[#3B2219]/20 bg-transparent px-2.5 py-1 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
              >
                <option value="">Tất cả</option>
                {data.colorFacets.map((col) => (
                  <option key={col} value={col}>
                    {col}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wider text-[#70584B]">Giá:</span>
              <input
                type="number"
                name="minPrice"
                aria-label="Giá tối thiểu"
                placeholder="Từ"
                min={0}
                max={data.limits.priceVnd}
                step={1000}
                defaultValue={discovery.minPriceVnd ?? ""}
                className="w-20 rounded border border-[#3B2219]/20 bg-transparent px-2 py-1 text-xs text-[#2A1810]"
              />
              <span>-</span>
              <input
                type="number"
                name="maxPrice"
                aria-label="Giá tối đa"
                placeholder="Đến"
                min={0}
                max={data.limits.priceVnd}
                step={1000}
                defaultValue={discovery.maxPriceVnd ?? ""}
                className="w-20 rounded border border-[#3B2219]/20 bg-transparent px-2 py-1 text-xs text-[#2A1810]"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
              >
                Áp dụng
              </button>
            </div>

            {data.filtered ? (
              <Link
                href="/shop"
                className="ml-auto font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 hover:text-[#2A1810]"
              >
                Xóa bộ lọc
              </Link>
            ) : null}
          </div>
        </form>

        <ShopActiveFilters
          discovery={discovery}
          collectionFacets={data.collectionFacets}
          filtered={data.filtered}
        />
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
