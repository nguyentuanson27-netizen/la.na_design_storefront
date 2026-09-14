import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  buildCollectionDiscoveryHref,
  parseCollectionDiscoverySearchParams,
} from "@/commerce/collection-discovery-url";
import { BRAND } from "@/brand";
import { CollectionDefinitionError } from "@/commerce/collection-definition";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import {
  listConfiguredStorefrontDiscoveryFacets,
  listConfiguredStorefrontDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { prisma } from "@/db/prisma";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { buildCollectionBreadcrumbStructuredData } from "@/seo/collection-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";
import { serializeJsonLd } from "@/seo/structured-data";

const PAGE_SIZE = 24;
const tones = ["stone", "olive", "ink", "sand"] as const;
const repository = createCollectionDefinitionRepository(prisma);
const sortOptions = [
  { value: "name-asc", label: "Tên A–Z" },
  { value: "name-desc", label: "Tên Z–A" },
  { value: "price-asc", label: "Giá thấp → cao" },
  { value: "price-desc", label: "Giá cao → thấp" },
] as const;
const optionLinkClassName =
  "inline-flex min-h-11 items-center border border-black/25 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-colors hover:border-black hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4";
const activeOptionLinkClassName = "border-black bg-black/10";

type CollectionSearchParams = Readonly<Record<string, string | string[] | undefined>>;

type CollectionPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<CollectionSearchParams>;
};

async function readPublishedCollection(slug: string) {
  try {
    return await repository.findPublishedBySlug(slug);
  } catch (error) {
    if (error instanceof CollectionDefinitionError) return null;
    throw error;
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: CollectionPageProps): Promise<Metadata> {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const collection = await readPublishedCollection(slug);
  const description = collection?.description?.trim();
  if (!collection || !description) return {};

  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: `/collections/${collection.slug}`,
    searchParams: query,
    title: collection.seoTitle?.trim() || collection.title,
    description: collection.seoDescription?.trim() || description,
  });
}

export default async function CollectionPage({ params, searchParams }: CollectionPageProps) {
  await connection();
  const { slug } = await params;
  const collection = await readPublishedCollection(slug);

  if (!collection || !collection.description?.trim()) notFound();

  let discovery: ReturnType<typeof parseCollectionDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryFacets>>;
  try {
    const query = await searchParams;
    discovery = parseCollectionDiscoverySearchParams(collection.slug, query);
    const requestNow = new Date();
    [catalogPage, facets] = await Promise.all([
      listConfiguredStorefrontDiscoveryPage({
        discovery,
        pageSize: PAGE_SIZE,
        now: requestNow,
      }),
      listConfiguredStorefrontDiscoveryFacets(),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  if (page > Math.max(totalPages, 1)) notFound();
  const listTracking = buildProductListTracking({
    products,
    list: { listId: `collection:${collection.slug}`, listName: collection.title },
    pricingRule,
  });

  const filtered = discovery.size !== null;
  const hrefFor = (
    state: Parameters<typeof buildCollectionDiscoveryHref>[1],
  ) => buildCollectionDiscoveryHref(collection.slug, state);
  const collectionBreadcrumb = buildCollectionBreadcrumbStructuredData({
    origin: readSearchExposure().origin,
    title: collection.title,
  });

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-10 md:py-16">
      <StorefrontPromotionRefresher refreshAfterMs={refreshAfterMs} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(collectionBreadcrumb) }}
      />
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-black/60">
          <li>
            <Link className="hover:underline" href="/">
              Trang chủ
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link className="hover:underline" href="/collections">
              Bộ sưu tập
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black">
            {collection.title}
          </li>
        </ol>
      </nav>
      <p className="eyebrow mt-6">{BRAND.identity.name} / Bộ sưu tập</p>
      <h1 className="mt-4 max-w-6xl break-words text-[clamp(2.5rem,8vw,7rem)] font-semibold leading-[0.88] tracking-[-0.05em]">
        {collection.title}
      </h1>
      <div className="mt-10 grid gap-8 border-t border-black/20 pt-8 md:grid-cols-2">
        <p className="max-w-2xl break-words font-serif text-2xl leading-snug md:text-3xl">
          {collection.description}
        </p>
        <p className="max-w-lg text-sm leading-6 text-black/65 md:justify-self-end">
          Khám phá các sản phẩm trong bộ sưu tập này. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.
        </p>
      </div>

      <section className="mt-12 grid gap-8 border-y border-black/20 py-6 md:grid-cols-2" aria-label="Điều khiển bộ sưu tập">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.13em]">Sắp xếp</p>
          <nav
            aria-label="Sắp xếp bộ sưu tập"
            className="mt-3 flex flex-wrap gap-2"
          >
            {sortOptions.map((option) => {
              const active = discovery.sort === option.value;
              return (
                <Link
                  aria-current={active ? "true" : undefined}
                  className={`${optionLinkClassName}${active ? ` ${activeOptionLinkClassName}` : ""}`}
                  href={hrefFor({
                    size: discovery.size,
                    sort: option.value,
                    page: 1,
                  })}
                  key={option.value}
                >
                  {option.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.13em]">Kích cỡ</p>
          <nav aria-label="Lọc theo kích cỡ" className="mt-3 flex flex-wrap gap-2">
            <Link
              aria-current={discovery.size === null ? "true" : undefined}
              className={`${optionLinkClassName}${
                discovery.size === null ? ` ${activeOptionLinkClassName}` : ""
              }`}
              href={hrefFor({
                size: null,
                sort: discovery.sort,
                page: 1,
              })}
            >
              Tất cả kích cỡ
            </Link>
            {facets.sizes.map((size) => {
              const active = discovery.size === size;
              return (
                <Link
                  aria-current={active ? "true" : undefined}
                  className={`${optionLinkClassName}${active ? ` ${activeOptionLinkClassName}` : ""}`}
                  href={hrefFor({
                    size,
                    sort: discovery.sort,
                    page: 1,
                  })}
                  key={size}
                >
                  {size}
                </Link>
              );
            })}
          </nav>
        </div>
      </section>

      {totalCount === 0 ? (
        <section className="mt-16 border-t border-black/20 py-16" aria-labelledby="collection-empty-title">
          <p className="eyebrow">{filtered ? "Không tìm thấy" : "Bộ sưu tập hiện tại"}</p>
          <h2 id="collection-empty-title" className="mt-4 max-w-2xl font-serif text-3xl leading-tight md:text-5xl">
            {filtered ? "Không có sản phẩm phù hợp." : "Bộ sưu tập này chưa có sản phẩm."}
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-black/65">
            {filtered
              ? "Thử chọn kích cỡ khác hoặc xem lại tất cả sản phẩm trong bộ sưu tập."
              : "Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập."}
          </p>
          {filtered ? (
            <Link
              className="mt-6 inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
              href={hrefFor({ size: null, sort: discovery.sort, page: 1 })}
            >
              Xem tất cả kích cỡ →
            </Link>
          ) : null}
        </section>
      ) : (
        <section className="mt-16" aria-labelledby="collection-products-title">
          <div className="section-heading-row border-t border-black/20 pt-5">
            <h2 id="collection-products-title">Sản phẩm</h2>
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
              aria-label="Phân trang bộ sưu tập"
            >
              {catalogPage.hasPrevious ? (
                <Link
                  className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                  href={hrefFor({
                    size: discovery.size,
                    sort: discovery.sort,
                    page: page - 1,
                  })}
                  rel="prev"
                >
                  ← Trang trước
                </Link>
              ) : (
                <span aria-hidden="true" />
              )}
              {catalogPage.hasNext ? (
                <Link
                  className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                  href={hrefFor({
                    size: discovery.size,
                    sort: discovery.sort,
                    page: page + 1,
                  })}
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
