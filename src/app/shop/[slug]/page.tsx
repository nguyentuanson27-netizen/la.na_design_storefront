import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  getConfiguredStorefrontProductBySlug,
  listConfiguredRelatedStorefrontProducts,
  resolveStorefrontPromotionForProducts,
} from "@/commerce/storefront-catalog-runtime";
import { BRAND } from "@/brand";
import { selectStorefrontProductLevelOptions } from "@/commerce/storefront-projection";
import { ProductGallery } from "@/components/commerce/product-gallery";
import { ProductPurchasePanel } from "@/components/commerce/product-purchase-panel";
import {
  CommerceEventReporter,
  isCommerceTrackingEnabled,
} from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildProductPageViewEvent } from "@/components/analytics/product-page-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import {
  VARIANT_QUERY_PARAM,
  resolveDeepLinkedVariantSelection,
} from "@/commerce/storefront-variant-deep-link";
import { readSearchExposure } from "@/seo/search-exposure";
import { serializeJsonLd } from "@/seo/structured-data";
import { buildStorefrontProductStructuredData } from "@/seo/storefront-product-structured-data";

const relatedTones = ["stone", "olive", "ink", "sand"] as const;

type ProductPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProductPage({ params, searchParams }: ProductPageProps) {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const requestNow = new Date();

  let product: Awaited<ReturnType<typeof getConfiguredStorefrontProductBySlug>>;
  try {
    product = await getConfiguredStorefrontProductBySlug(slug, requestNow);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  if (!product) notFound();

  const relatedProducts = await listConfiguredRelatedStorefrontProducts(product, requestNow);
  const promotion = await resolveStorefrontPromotionForProducts({
    products: [product, ...relatedProducts],
    now: requestNow,
  });
  const relatedPricingRule = promotion.pricingRule;
  const relatedTracking = buildProductListTracking({
    products: relatedProducts,
    list: { listId: "related-products", listName: "Hoàn thiện phối đồ" },
    pricingRule: relatedPricingRule,
  });
  const options = product.projection.options;
  const productLevelOptions = selectStorefrontProductLevelOptions(product.projection);
  const deepLinkedSelection = resolveDeepLinkedVariantSelection({
    projection: product.projection,
    variantQuery: typeof query[VARIANT_QUERY_PARAM] === "string" ? query[VARIANT_QUERY_PARAM] : null,
  });
  const deepLinkedImageIndex =
    deepLinkedSelection === null
      ? 0
      : product.galleryIndexByVariantId[deepLinkedSelection.variantId] ?? 0;
  const productViewEvent = buildProductPageViewEvent({
    pancakeProductId: product.pancakeProductId,
    name: product.name,
    options,
    deepLinkedSelection,
  });
  const structuredData = buildStorefrontProductStructuredData({
    origin: readSearchExposure().origin,
    product,
  });

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-10 md:py-16">
      <StorefrontPromotionRefresher refreshAfterMs={promotion.refreshAfterMs} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
      />
      <CommerceEventReporter event={productViewEvent} />
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-black/60">
          <li><Link className="hover:underline" href="/">Trang chủ</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link className="hover:underline" href="/shop">Cửa hàng</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black">{product.name}</li>
        </ol>
      </nav>

      <div className="mt-7 grid min-w-0 gap-10 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-16">
        <ProductGallery
          media={product.media}
          productName={product.name}
          initialIndex={deepLinkedImageIndex}
        />

        <article className="min-w-0 pb-10 lg:pt-4">
          <p className="eyebrow">{BRAND.identity.name} / Sản phẩm</p>
          <h1 className="mt-5 break-words text-[clamp(2.8rem,6vw,6.5rem)] font-semibold leading-[0.9] tracking-[-0.045em]">
            {product.name}
          </h1>

          {product.collections.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {product.collections.map((collection) => (
                <Link key={collection.slug} href={`/collections/${collection.slug}`} className="badge badge--stone transition-colors hover:border-black">
                  {collection.title}
                </Link>
              ))}
            </div>
          ) : null}

          {product.editorialDescription ? (
            <p className="mt-7 max-w-2xl break-words font-serif text-2xl leading-snug text-black/80 md:text-3xl">
              {product.editorialDescription}
            </p>
          ) : (
            <p className="mt-7 max-w-xl text-sm leading-6 text-black/60">
              Thông tin biên tập cho sản phẩm này đang được cập nhật.
            </p>
          )}

          <div className="mt-10">
            <ProductPurchasePanel
              slug={product.slug}
              productName={product.name}
              options={options}
              productLevelOptions={productLevelOptions}
              initialSelection={deepLinkedSelection}
              commerceTrackingEnabled={isCommerceTrackingEnabled()}
            />
          </div>

          {(product.sizeGuide || product.careInstructions) && (
            <section className="mt-12 border-t border-black/20" aria-labelledby="product-notes-title">
              <h2 id="product-notes-title" className="sr-only">Thông tin sản phẩm</h2>
              {product.sizeGuide ? (
                <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Hướng dẫn chọn kích cỡ</h3>
                  <p className="max-w-xl text-sm leading-6 text-black/70">{product.sizeGuide}</p>
                </div>
              ) : null}
              {product.careInstructions ? (
                <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Bảo quản</h3>
                  <p className="max-w-xl text-sm leading-6 text-black/70">{product.careInstructions}</p>
                </div>
              ) : null}
            </section>
          )}

          <p className="mt-8 max-w-xl text-xs leading-5 text-black/60">
            Tình trạng còn hàng được hệ thống kiểm tra lại khi bạn thêm sản phẩm vào giỏ hàng. Số lượng tồn kho chính xác không được hiển thị trên website.
          </p>
        </article>
      </div>

      {relatedProducts.length > 0 ? (
        <section aria-labelledby="related-products-title" className="mt-20 border-t border-black/20 pt-6">
          <div className="section-heading-row">
            <h2 id="related-products-title">Hoàn thiện phối đồ</h2>
            <p className="eyebrow">Cùng bộ sưu tập</p>
          </div>
          <CommerceEventReporter event={relatedTracking.listEvent} />
          <div className="product-grid">
            {relatedProducts.map((related, index) => (
              <StorefrontProductCard
                key={related.id}
                slug={related.slug}
                name={related.name}
                media={related.media}
                variants={related.variants}
                pricingRule={relatedPricingRule}
                selectEvent={relatedTracking.selectEventBySlug.get(related.slug) ?? null}
                tone={relatedTones[index % relatedTones.length]!}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
