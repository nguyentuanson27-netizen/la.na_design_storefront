import Link from "next/link";

import { BRAND } from "@/brand";
import { CommerceEventReporter } from "@/components/brand/commerce-event-reporter";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { BrandProductDetail } from "@/components/brand/product-detail";
import { createStorefrontRoute } from "@/routes/factory";
import { loadProductRoute, type ProductRouteData, type ProductRouteProps } from "@/routes/product";

/**
 * Markup only. The product, its related grid, the deep link, the JSON-LD and the view event all
 * live in `@/routes/product`; metadata stays in the sibling layout, which is the one route in the
 * manifest whose metadata is not on the page.
 *
 * Refinement spec §3 splits what used to be one `afterPanel`: the product's own story goes in the
 * left information column, the facts a shopper checks while deciding to buy -- delivery and
 * returns -- go under the purchase panel on the right.
 */

const relatedTones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: ProductRouteData) {
  const { editorial } = data;

  const breadcrumb = (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-black/60">
        <li><Link className="hover:underline" href="/">Trang chủ</Link></li>
        <li aria-hidden="true">/</li>
        <li><Link className="hover:underline" href="/shop">Cửa hàng</Link></li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-black">{data.name}</li>
      </ol>
    </nav>
  );

  const identity = (
    <>
      <p className="eyebrow">{BRAND.identity.name} / Sản phẩm</p>
      {/* Master spec §9: the product's name is a heading, so it wears the elegant serif the rest
          of the brand's headings wear rather than the condensed bold sans it used to shout in. */}
      <h1 className="mt-5 break-words font-serif text-[clamp(2.4rem,5vw,4.5rem)] font-normal leading-[1.02] tracking-[-0.035em]">
        {data.name}
      </h1>

      {data.collections.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {data.collections.map((collection) => (
            <Link
              key={collection.slug}
              href={`/collections/${collection.slug}`}
              className="badge badge--stone transition-colors hover:border-black"
            >
              {collection.title}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );

  const productInformation = (
    <section aria-label="Chi tiết sản phẩm" className="border-t border-black/20">
      {editorial.description || editorial.craftDetails.length > 0 ? (
        <section className="border-b border-black/15 py-6" aria-labelledby="pdp-description-title">
          <h2 id="pdp-description-title" className="font-serif text-xl font-normal tracking-[-0.02em]">
            Mô tả sản phẩm
          </h2>
          {editorial.description ? (
            <p className="mt-3 max-w-xl text-sm leading-6 text-black/70">{editorial.description}</p>
          ) : null}
          {editorial.craftDetails.length > 0 ? (
            <ul className="mt-3 max-w-xl list-disc space-y-1 pl-5 text-sm leading-6 text-black/70">
              {editorial.craftDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {editorial.material ? (
        <section className="border-b border-black/15 py-6" aria-labelledby="pdp-material-title">
          <h2 id="pdp-material-title" className="font-serif text-xl font-normal tracking-[-0.02em]">
            Chất liệu
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-black/70">{editorial.material}</p>
        </section>
      ) : null}

      {/*
        The approved order includes "Thông số/fit", but current ProductContent has no dedicated,
        approved fit/measurement fact. Size options, category and craft details are not fit facts,
        so F7e truthfully omits the block until such a source exists.
      */}

      {editorial.careInstructions ? (
        <section className="border-b border-black/15 py-6" aria-labelledby="pdp-care-title">
          <h2 id="pdp-care-title" className="font-serif text-xl font-normal tracking-[-0.02em]">
            Hướng dẫn bảo quản
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-black/70">
            {editorial.careInstructions}
          </p>
        </section>
      ) : null}
    </section>
  );

  const purchaseInformation = (
    <section aria-label="Giao hàng và đổi trả" className="border-t border-black/20">
      <section className="border-b border-black/15 py-6" aria-labelledby="pdp-shipping-title">
        <h2 id="pdp-shipping-title" className="font-serif text-xl font-normal tracking-[-0.02em]">
          Giao hàng
        </h2>
        <div className="mt-3 max-w-xl space-y-1 text-sm leading-6 text-black/70">
          <p>{data.shipping.coverage}</p>
          <p>{data.shipping.innerCityLabel}: {data.shipping.innerCityEstimate}</p>
          <p>{data.shipping.otherProvinceLabel}: {data.shipping.otherProvinceEstimate}</p>
          <p>{data.shipping.estimateCaveat}</p>
          <Link className="inline-block underline underline-offset-4" href="/shipping">
            Xem chính sách vận chuyển
          </Link>
        </div>
      </section>

      <section className="border-b border-black/15 py-6" aria-labelledby="pdp-returns-title">
        <h2 id="pdp-returns-title" className="font-serif text-xl font-normal tracking-[-0.02em]">
          Đổi trả
        </h2>
        <div className="mt-3 max-w-xl space-y-1 text-sm leading-6 text-black/70">
          <p>{data.returns.returnWindow}</p>
          <p>{data.returns.refundWindow}</p>
          <Link className="inline-block underline underline-offset-4" href="/returns">
            Xem chính sách đổi trả
          </Link>
        </div>
      </section>
    </section>
  );

  return (
    <>
      <BrandProductDetail
        selection={{
          slug: data.slug,
          productName: data.name,
          options: data.options,
          productLevelOptions: data.productLevelOptions,
          initialSelection: data.deepLinkedSelection,
          commerceTrackingEnabled: data.commerceTrackingEnabled,
        }}
        media={data.media}
        productName={data.name}
        initialGalleryIndex={data.initialGalleryIndex}
        galleryIndexByVariantId={data.galleryIndexByVariantId}
        sizeGuide={editorial.sizeGuide}
        breadcrumb={breadcrumb}
        identity={identity}
        productInformation={productInformation}
        purchaseInformation={purchaseInformation}
      />

      {data.relatedCards.length > 0 ? (
        <div className="mx-auto max-w-[1600px] px-6 pb-16">
          <section aria-labelledby="related-products-title" className="border-t border-black/20 pt-6">
            <div className="section-heading-row">
              {/*
                The generic related source is manual overrides or a same-category fallback. Neither
                proves the items complete an outfit, so the heading says what the data supports.
              */}
              <h2 id="related-products-title">Nàng có thể thích</h2>
              <p className="eyebrow">Sản phẩm liên quan</p>
            </div>
            <CommerceEventReporter event={data.relatedListEvent} />
            <div className="product-grid">
              {data.relatedCards.map((card, index) => (
                <ProductCard
                  key={card.id}
                  model={card.model}
                  tone={relatedTones[index % relatedTones.length]!}
                />
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

const route = createStorefrontRoute<ProductRouteProps, ProductRouteData>({
  load: loadProductRoute,
  render,
});

export default route.Page;
