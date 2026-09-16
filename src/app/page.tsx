import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { createStorefrontRoute } from "@/routes/factory";
import { loadHomeRoute, type HomeRouteData, type HomeRouteProps } from "@/routes/home";
import { buildHomeMetadata } from "@/routes/metadata/home";
import type { HomeEditorialPanel } from "@/routes/home-model";

const tones: readonly ProductCardTone[] = ["stone", "ink", "olive", "sand"];

function EditorialPanel({
  panel,
  className,
  fallbackAlt,
  sizes,
  preload = false,
}: Readonly<{
  panel: HomeEditorialPanel;
  className: string;
  fallbackAlt: string;
  sizes: string;
  preload?: boolean;
}>) {
  if (!panel) return <div className={className} aria-hidden="true" />;

  return (
    <div className={className}>
      <Image
        src={panel.image.url}
        alt={panel.image.alt || panel.productName || fallbackAlt}
        fill
        preload={preload}
        sizes={sizes}
        className="object-cover"
      />
    </div>
  );
}

function render(data: HomeRouteData) {
  const { brandFacts } = data;

  return (
    <>
      <section className="campaign-hero" aria-labelledby="campaign-title">
        <EditorialPanel
          panel={data.hero}
          className="campaign-visual relative min-h-[620px] overflow-hidden bg-[var(--stone)]"
          fallbackAlt={`${BRAND.identity.name} Campaign`}
          sizes="(min-width: 900px) 60vw, 100vw"
          preload
        />
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
        {data.cards.length > 0 ? (
          <div className="product-grid">
            {data.cards.map((card, index) => (
              <ProductCard key={card.id} model={card.model} tone={tones[index % tones.length]!} />
            ))}
          </div>
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
        <EditorialPanel
          panel={data.lookbookLarge}
          className="lookbook-panel lookbook-panel--large relative min-h-[68vh] overflow-hidden bg-[#b9b2a4] md:min-h-[780px]"
          fallbackAlt={`${BRAND.identity.name} Lookbook`}
          sizes="(min-width: 900px) 50vw, 100vw"
        />
        <div className="lookbook-copy">
          <p className="eyebrow">Editorial / 02</p>
          <h2 id="lookbook-title">CITY UNIFORM</h2>
          <p>Measured proportions and functional utility for moving through the everyday.</p>
          <Link className="text-link" href="/collections">Xem bộ sưu tập ↗</Link>
        </div>
        <EditorialPanel
          panel={data.lookbookSmall}
          className="lookbook-panel lookbook-panel--small relative min-h-[55vh] overflow-hidden bg-[var(--olive)]"
          fallbackAlt={`${BRAND.identity.name} Detail`}
          sizes="(min-width: 900px) 25vw, 100vw"
        />
      </section>

      {data.collections.length > 0 ? (
        <section
          className="category-strip"
          aria-labelledby="homepage-collections-title"
          data-homepage-region="collection-navigation"
        >
          <p className="eyebrow" id="homepage-collections-title">Mua theo bộ sưu tập</p>
          <nav className="category-links" aria-label="Bộ sưu tập nổi bật">
            {data.collections.map((collection) => (
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

const route = createStorefrontRoute<HomeRouteProps, HomeRouteData>({
  load: loadHomeRoute,
  metadata: (props) => buildHomeMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
