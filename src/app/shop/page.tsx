import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  listConfiguredStorefrontDiscoveryFacets,
  listConfiguredStorefrontDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import {
  buildStorefrontDiscoveryHref,
  parseStorefrontDiscoverySearchParams,
  STOREFRONT_DISCOVERY_LIMITS,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { BRAND } from "@/brand";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

const SHOP_TITLE = "Cửa hàng";
const SHOP_DESCRIPTION = `Khám phá thời trang nam ${BRAND.identity.name} đang có sẵn tại cửa hàng.`;
const PAGE_SIZE = 24;
const tones = ["stone", "olive", "ink", "sand"] as const;
const controlClassName =
  "min-h-11 w-full border-b border-black/30 bg-transparent px-0 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

type ShopPageProps = {
  searchParams: Promise<StorefrontDiscoverySearchParams>;
};

export async function generateMetadata({ searchParams }: ShopPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/shop",
    searchParams: await searchParams,
    title: SHOP_TITLE,
    description: SHOP_DESCRIPTION,
  });
}

function hasActiveDiscovery(discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>) {
  return (
    discovery.query !== null ||
    discovery.color !== null ||
    discovery.size !== null ||
    discovery.availability !== null ||
    discovery.minPriceVnd !== null ||
    discovery.maxPriceVnd !== null ||
    discovery.collection !== null ||
    discovery.sort !== "name-asc"
  );
}

function collectionLabel(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length > 0 ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

export default async function ShopPage({ searchParams }: ShopPageProps) {
  await connection();

  // One instant for the whole request: the count, the ordering, the SQL projection, transition
  // aggregation and the card prices all agree.
  const requestNow = new Date();

  let discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryFacets>>;
  try {
    discovery = parseStorefrontDiscoverySearchParams(await searchParams);
    [catalogPage, facets] = await Promise.all([
      listConfiguredStorefrontDiscoveryPage({ discovery, pageSize: PAGE_SIZE, now: requestNow }),
      listConfiguredStorefrontDiscoveryFacets(),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  // One impression per rendered card, priced by the rule that ordered and rendered the grid.
  const listTracking = buildProductListTracking({
    products,
    list: { listId: "shop", listName: SHOP_TITLE },
    pricingRule,
  });
  if (page > Math.max(totalPages, 1)) notFound();
  const filtered = hasActiveDiscovery(discovery);

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <StorefrontPromotionRefresher refreshAfterMs={refreshAfterMs} />
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
          {filtered ? (
            <Link
              className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
              href="/shop"
            >
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
              maxLength={STOREFRONT_DISCOVERY_LIMITS.query}
              name="q"
              placeholder="Tên sản phẩm"
              type="search"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">Bộ sưu tập</span>
            <select className={controlClassName} defaultValue={discovery.collection ?? ""} name="collection">
              <option value="">Tất cả</option>
              {facets.collections.map((collection) => (
                <option key={collection} value={collection}>
                  {collectionLabel(collection)}
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
              {facets.colors.map((color) => (
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
              {facets.sizes.map((size) => (
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
              max={STOREFRONT_DISCOVERY_LIMITS.priceVnd}
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
              max={STOREFRONT_DISCOVERY_LIMITS.priceVnd}
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

      {totalCount === 0 ? (
        <section className="mt-16 border-t border-black/20 py-16" aria-labelledby="shop-empty-title">
          <p className="eyebrow">{filtered ? "Không tìm thấy" : "Sản phẩm hiện tại"}</p>
          <h2 id="shop-empty-title" className="mt-4 max-w-2xl font-serif text-3xl leading-tight md:text-5xl">
            {filtered ? "Không có sản phẩm phù hợp." : "Chưa có sản phẩm đang mở bán."}
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-black/65">
            {filtered
              ? "Thử bỏ bớt bộ lọc hoặc xem lại tất cả sản phẩm."
              : "Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để mua trên website."}
          </p>
          {filtered ? (
            <Link
              className="mt-6 inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
              href="/shop"
            >
              Xem tất cả sản phẩm →
            </Link>
          ) : null}
        </section>
      ) : (
        <section className="mt-16" aria-labelledby="shop-products-title">
          <div className="section-heading-row border-t border-black/20 pt-5">
            <h2 id="shop-products-title">Sản phẩm hiện tại</h2>
            <p className="eyebrow">
              {totalCount} sản phẩm · Trang {page}/{totalPages}
            </p>
          </div>
          <CommerceEventReporter event={listTracking.listEvent} />
          <div className="product-grid">
            {products.map((product, index) => (
              <StorefrontProductCard
                key={product.id}
                slug={product.slug}
                name={product.name}
                media={product.media}
                variants={product.variants}
                pricingRule={pricingRule}
                selectEvent={listTracking.selectEventBySlug.get(product.slug) ?? null}
                tone={tones[((page - 1) * PAGE_SIZE + index) % tones.length]!}
              />
            ))}
          </div>

          {totalPages > 1 ? (
            <nav
              className="mt-12 flex items-center justify-between gap-4 border-t border-black/20 pt-6"
              aria-label="Phân trang sản phẩm"
            >
              {catalogPage.hasPrevious ? (
                <Link
                  className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
                  href={buildStorefrontDiscoveryHref(discovery, page - 1)}
                  rel="prev"
                >
                  ← Trang trước
                </Link>
              ) : (
                <span aria-hidden="true" />
              )}
              {catalogPage.hasNext ? (
                <Link
                  className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
                  href={buildStorefrontDiscoveryHref(discovery, page + 1)}
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
