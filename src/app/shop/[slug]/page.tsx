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
 */

const relatedTones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: ProductRouteData) {
  const { editorial } = data;

  const beforePanel = (
    <>
      <p className="eyebrow">{BRAND.identity.name} / Sản phẩm</p>
      <h1 className="mt-5 break-words text-[clamp(2.8rem,6vw,6.5rem)] font-semibold leading-[0.9] tracking-[-0.045em]">
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

      {editorial.description ? (
        <p className="mt-7 max-w-2xl break-words font-serif text-2xl leading-snug text-black/80 md:text-3xl">
          {editorial.description}
        </p>
      ) : (
        <p className="mt-7 max-w-xl text-sm leading-6 text-black/60">
          Thông tin biên tập cho sản phẩm này đang được cập nhật.
        </p>
      )}
    </>
  );

  const afterPanel = (
    <>
      {editorial.hasNotes ? (
        <section className="mt-12 border-t border-black/20" aria-labelledby="product-notes-title">
          <h2 id="product-notes-title" className="sr-only">Thông tin sản phẩm</h2>
          {editorial.material ? (
            <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Chất liệu</h3>
              <p className="max-w-xl text-sm leading-6 text-black/70">{editorial.material}</p>
            </div>
          ) : null}
          {editorial.craftDetails.length > 0 ? (
            <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Hoàn thiện</h3>
              <ul className="max-w-xl list-disc space-y-1 pl-5 text-sm leading-6 text-black/70">
                {editorial.craftDetails.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {editorial.sizeGuide ? (
            <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Hướng dẫn chọn kích cỡ</h3>
              <p className="max-w-xl text-sm leading-6 text-black/70">{editorial.sizeGuide}</p>
            </div>
          ) : null}
          {editorial.careInstructions ? (
            <div className="grid gap-3 border-b border-black/15 py-6 sm:grid-cols-[8rem_1fr]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em]">Bảo quản</h3>
              <p className="max-w-xl text-sm leading-6 text-black/70">{editorial.careInstructions}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="mt-8 max-w-xl text-xs leading-5 text-black/60">
        Tình trạng còn hàng được hệ thống kiểm tra lại khi bạn thêm sản phẩm vào giỏ hàng. Số lượng tồn kho chính xác không được hiển thị trên website.
      </p>
    </>
  );

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-10 md:py-16">
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-black/60">
          <li><Link className="hover:underline" href="/">Trang chủ</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link className="hover:underline" href="/shop">Cửa hàng</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black">{data.name}</li>
        </ol>
      </nav>

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
        beforePanel={beforePanel}
        afterPanel={afterPanel}
      />

      {data.relatedCards.length > 0 ? (
        <section aria-labelledby="related-products-title" className="mt-20 border-t border-black/20 pt-6">
          <div className="section-heading-row">
            <h2 id="related-products-title">Hoàn thiện phối đồ</h2>
            <p className="eyebrow">Cùng bộ sưu tập</p>
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
      ) : null}
    </div>
  );
}

const route = createStorefrontRoute<ProductRouteProps, ProductRouteData>({
  load: loadProductRoute,
  render,
});

export default route.Page;
