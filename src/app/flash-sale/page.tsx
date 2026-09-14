import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  listConfiguredFlashSalePage,
  readConfiguredNextFlashSaleBoundary,
} from "@/commerce/storefront-catalog-runtime";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { BRAND } from "@/brand";
import { resolveStorefrontPromotionRefresh } from "@/commerce/storefront-promotion-freshness";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

const FLASH_TITLE = "Flash Sale";
const FLASH_DESCRIPTION = `Các sản phẩm đang giảm giá trong khung giờ Flash Sale của ${BRAND.identity.name}.`;
const PAGE_SIZE = 24;
const tones = ["stone", "olive", "ink", "sand"] as const;

type FlashSalePageProps = {
  searchParams: Promise<StorefrontDiscoverySearchParams>;
};

export async function generateMetadata({ searchParams }: FlashSalePageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/flash-sale",
    searchParams: await searchParams,
    title: FLASH_TITLE,
    description: FLASH_DESCRIPTION,
  });
}

export default async function FlashSalePage({ searchParams }: FlashSalePageProps) {
  await connection();

  // One server instant for membership, pricing, representative selection and refresh alike.
  const requestNow = new Date();

  let discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>;
  let flashPage: Awaited<ReturnType<typeof listConfiguredFlashSalePage>>;
  let nextBoundaryAt: Awaited<ReturnType<typeof readConfiguredNextFlashSaleBoundary>>;
  try {
    discovery = parseStorefrontDiscoverySearchParams(await searchParams);
    [flashPage, nextBoundaryAt] = await Promise.all([
      listConfiguredFlashSalePage({ discovery, pageSize: PAGE_SIZE, now: requestNow }),
      readConfiguredNextFlashSaleBoundary(requestNow),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages } = flashPage;
  const listTracking = buildProductListTracking({
    products,
    list: { listId: "flash-sale", listName: FLASH_TITLE },
  });
  const { refreshAfterMs } = resolveStorefrontPromotionRefresh({
    now: requestNow,
    nextBoundaryAt,
  });

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-10 md:py-16">
      <StorefrontPromotionRefresher refreshAfterMs={refreshAfterMs} />

      <header>
        <p className="eyebrow">{BRAND.identity.name} / Khuyến mãi</p>
        <h1 className="mt-5 text-[clamp(2.8rem,6vw,6.5rem)] font-semibold leading-[0.9] tracking-[-0.045em]">
          {FLASH_TITLE}
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-6 text-black/65">{FLASH_DESCRIPTION}</p>
      </header>

      <section aria-labelledby="flash-sale-results" className="mt-12 border-t border-black/20 pt-8">
        <h2 id="flash-sale-results" className="sr-only">
          Sản phẩm đang giảm giá
        </h2>

        <p aria-live="polite" className="text-xs uppercase tracking-[0.14em] text-black/55">
          {totalCount === 0
            ? "Hiện chưa có sản phẩm nào trong khung giờ Flash Sale."
            : `${totalCount} sản phẩm đang giảm giá`}
        </p>

        {products.length > 0 ? (
          <>
          <CommerceEventReporter event={listTracking.listEvent} />
          <div className="product-grid mt-8">
            {products.map((product, index) => (
              <StorefrontProductCard
                key={product.id}
                slug={product.slug}
                name={product.name}
                media={product.media}
                variants={product.variants}
                flashSale={product.flashSale}
                selectEvent={listTracking.selectEventBySlug.get(product.slug) ?? null}
                tone={tones[((page - 1) * PAGE_SIZE + index) % tones.length]!}
              />
            ))}
          </div>
          </>
        ) : (
          <p className="mt-8 max-w-xl text-sm leading-6 text-black/70">
            Hãy quay lại sau — trang này tự cập nhật khi khung giờ Flash Sale bắt đầu.{" "}
            <Link className="underline" href="/shop">
              Xem toàn bộ cửa hàng
            </Link>
            .
          </p>
        )}

        {totalPages > 1 ? (
          <nav
            aria-label="Phân trang Flash Sale"
            className="mt-12 flex items-center justify-between gap-4 border-t border-black/20 pt-6"
          >
            {page > 1 ? (
              <Link className="underline" href={`/flash-sale?page=${page - 1}`}>
                Trang trước
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
            <p className="text-xs uppercase tracking-[0.14em] text-black/55">
              Trang {page} / {totalPages}
            </p>
            {page < totalPages ? (
              <Link className="underline" href={`/flash-sale?page=${page + 1}`}>
                Trang sau
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
