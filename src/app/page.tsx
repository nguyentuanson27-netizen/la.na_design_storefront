import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";

import { BRAND } from "@/brand";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import { listConfiguredStorefrontDiscoveryPage } from "@/commerce/storefront-catalog-runtime";
import { parseStorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { buildPublicBrandFacts } from "@/content/public-brand-facts";
import { prisma } from "@/db/prisma";
import { PancakeConfigError } from "@/integrations/pancake/config";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

const tones = ["stone", "ink", "olive", "sand"] as const;
const collectionRepository = createCollectionDefinitionRepository(prisma);

type HomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The homepage declares no title or description of its own; both stay inherited from the root
// metadata. This adds the self-canonical and nothing else.
export async function generateMetadata({ searchParams }: HomePageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/",
    searchParams: await searchParams,
  });
}

async function loadHomepageProductEdit(now: Date) {
  try {
    const discovery = parseStorefrontDiscoverySearchParams({});
    const page = await listConfiguredStorefrontDiscoveryPage({
      discovery,
      pageSize: 20,
      now,
    });
    return {
      products: page.products,
      pricingRule: page.pricingRule,
      refreshAfterMs: page.refreshAfterMs,
    };
  } catch (error) {
    if (error instanceof PancakeConfigError) {
      return { products: [], pricingRule: undefined, refreshAfterMs: 60_000 };
    }
    throw error;
  }
}

export default async function HomePage() {
  await connection();
  const requestNow = new Date();
  const [{ products: featuredProducts, pricingRule, refreshAfterMs }, publishedCollections] = await Promise.all([
    loadHomepageProductEdit(requestNow),
    collectionRepository.listHomepageMerchandising(),
  ]);
  const brandFacts = buildPublicBrandFacts(readGuestShippingPolicy());
  const productsWithMedia = featuredProducts.filter((p) => p.media?.primary);
  const listTracking = buildProductListTracking({
    products: featuredProducts,
    list: { listId: "homepage-edit", listName: "Tuyển chọn" },
    pricingRule,
  });
  const heroProduct = productsWithMedia[0];
  const heroImage = heroProduct?.media?.primary ?? null;
  const lookbookLargeProduct = productsWithMedia[1] ?? productsWithMedia[0];
  const lookbookLargeImage = lookbookLargeProduct?.media?.primary ?? null;
  const lookbookSmallProduct =
    productsWithMedia[2] ?? productsWithMedia[1] ?? productsWithMedia[0];
  const lookbookSmallImage = lookbookSmallProduct?.media?.primary ?? null;

  return (
    <>
      <StorefrontPromotionRefresher refreshAfterMs={refreshAfterMs} />
      <section className="campaign-hero" aria-labelledby="campaign-title">
        {heroImage ? (
          <div className="campaign-visual relative min-h-[620px] overflow-hidden bg-[var(--stone)]">
            <Image
              src={heroImage.url}
              alt={heroImage.alt || heroProduct?.name || `${BRAND.identity.name} Campaign`}
              fill
              preload
              sizes="(min-width: 900px) 60vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : (
          <div
            className="campaign-visual relative min-h-[620px] overflow-hidden bg-[var(--stone)]"
            aria-hidden="true"
          />
        )}
        <div className="campaign-copy">
          <p className="eyebrow">{BRAND.identity.name} / Campaign</p>
          <h1 id="campaign-title">QUIET FORM.</h1>
          <p className="campaign-intro">
            Clean lines, relaxed proportions and a muted palette designed for everyday movement.
          </p>
          <Link className="text-link" href="/shop">
            Mua bộ sưu tập <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>

      <section className="collection-intro" aria-labelledby="new-collection-title">
        <p className="eyebrow">Collection / 01</p>
        <h2 id="new-collection-title">ESSENTIALS FOR THE IN-BETWEEN.</h2>
        <div>
          <p>
            Shirts, trousers and layers built around proportion rather than noise — simple enough to wear every day,
            distinct enough to feel considered.
          </p>
          <Link className="text-link mt-4 inline-block" href="/collections">
            Xem các bộ sưu tập ↗
          </Link>
        </div>
      </section>

      <section className="product-section" aria-labelledby="shop-edit-title">
        <div className="section-heading-row">
          <h2 id="shop-edit-title">Tuyển chọn</h2>
          <Link className="text-link" href="/shop">Xem tất cả</Link>
        </div>
        {featuredProducts.length > 0 ? (
          <>
          <CommerceEventReporter event={listTracking.listEvent} />
          <div className="product-grid">
            {featuredProducts.map((product, index) => (
              <StorefrontProductCard
                key={product.id}
                slug={product.slug}
                name={product.name}
                media={product.media}
                variants={product.variants}
                pricingRule={pricingRule}
                selectEvent={listTracking.selectEventBySlug.get(product.slug) ?? null}
                tone={tones[index % tones.length]!}
              />
            ))}
          </div>
          </>
        ) : (
          <section
            aria-labelledby="homepage-empty-title"
            className="ui-state ui-state--empty"
            data-ui-state="empty"
          >
            <p className="eyebrow">Tuyển chọn hiện tại</p>
            <h2 id="homepage-empty-title" className="ui-state__title">
              Tuyển chọn hiện tại đang được chuẩn bị.
            </h2>
            <p className="ui-state__copy">
              Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để hiển thị trên website.
            </p>
          </section>
        )}
      </section>

      <section className="lookbook-grid" aria-labelledby="lookbook-title">
        {lookbookLargeImage ? (
          <div className="lookbook-panel lookbook-panel--large relative min-h-[68vh] overflow-hidden bg-[#b9b2a4] md:min-h-[780px]">
            <Image
              src={lookbookLargeImage.url}
              alt={lookbookLargeImage.alt || lookbookLargeProduct?.name || `${BRAND.identity.name} Lookbook`}
              fill
              sizes="(min-width: 900px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : (
          <div
            className="lookbook-panel lookbook-panel--large relative min-h-[68vh] overflow-hidden bg-[#b9b2a4] md:min-h-[780px]"
            aria-hidden="true"
          />
        )}
        <div className="lookbook-copy">
          <p className="eyebrow">Editorial / 02</p>
          <h2 id="lookbook-title">CITY UNIFORM</h2>
          <p>Measured proportions and functional utility for moving through the everyday.</p>
          <Link className="text-link" href="/lookbook">Xem lookbook ↗</Link>
        </div>
        {lookbookSmallImage ? (
          <div className="lookbook-panel lookbook-panel--small relative min-h-[55vh] overflow-hidden bg-[var(--olive)]">
            <Image
              src={lookbookSmallImage.url}
              alt={lookbookSmallImage.alt || lookbookSmallProduct?.name || `${BRAND.identity.name} Detail`}
              fill
              sizes="(min-width: 900px) 25vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : (
          <div
            className="lookbook-panel lookbook-panel--small relative min-h-[55vh] overflow-hidden bg-[var(--olive)]"
            aria-hidden="true"
          />
        )}
      </section>

      {publishedCollections.length > 0 ? (
        <section
          className="category-strip"
          aria-labelledby="homepage-collections-title"
          data-homepage-region="collection-navigation"
        >
          <p className="eyebrow" id="homepage-collections-title">Mua theo bộ sưu tập</p>
          <nav className="category-links" aria-label="Bộ sưu tập nổi bật">
            {publishedCollections.map((collection) => (
              <Link key={collection.slug} href={`/collections/${collection.slug}`}>
                {collection.title}
              </Link>
            ))}
          </nav>
        </section>
      ) : null}

      <section
        className="collection-intro"
        aria-labelledby="brand-facts-title"
        data-homepage-region="trust-support"
      >
        <p className="eyebrow">{BRAND.identity.name} / About</p>
        <h2 id="brand-facts-title">{brandFacts.brandName}</h2>
        <div>
          <p className="font-serif text-2xl leading-snug md:text-3xl">{brandFacts.brandSummary}</p>
          <dl className="mt-8 space-y-5 text-sm leading-6">
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Thanh toán</dt>
              <dd className="mt-1 text-black/70">
                {brandFacts.paymentMethod} {brandFacts.checkoutAccount}
              </dd>
            </div>
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Vận chuyển</dt>
              <dd className="mt-1 text-black/70">
                {brandFacts.shipping.title}. {brandFacts.shipping.detail}
              </dd>
            </div>
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Xác nhận đơn hàng</dt>
              <dd className="mt-1 text-black/70">{brandFacts.serverVerification}</dd>
            </div>
          </dl>
          <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-3" aria-label="Hỗ trợ và khám phá">
            <Link className="text-link" href="/shop">Cửa hàng ↗</Link>
            <Link className="text-link" href="/collections">Bộ sưu tập ↗</Link>
            <Link className="text-link" href="/track-order">Tra cứu đơn ↗</Link>
          </nav>
        </div>
      </section>
    </>
  );
}
