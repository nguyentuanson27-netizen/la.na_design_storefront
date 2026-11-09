import Link from "next/link";

import { BRAND, messengerUrlFromFanpage, zaloUrlFromTelephone } from "@/brand";
import { CommerceEventReporter } from "@/components/brand/commerce-event-reporter";
import { FeedbackRail } from "@/components/brand/feedback-gallery";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { PdpClampedContent, PdpDisclosure } from "@/components/brand/pdp-disclosure";
import { BrandProductDetail } from "@/components/brand/product-detail";
import { ProductReviews } from "@/components/brand/product-reviews";
import { CustomerPhotoStrip, ProductRatingLink } from "@/components/brand/product-review-summary";
import {
  PRODUCT_FEEDBACK_ANCHOR,
  resolveCustomerPhotoStrip,
  stripReplacesFeedbackLink,
} from "@/components/headless/customer-photo-strip-model";
import { PRODUCT_REVIEW_PHOTOS_ANCHOR } from "@/components/headless/product-review-model";
import { VoucherTeaserChips } from "@/components/brand/voucher-teaser-chips";
import { VoucherIcon } from "@/components/brand/voucher-icons";
import type { PurchaseAssuranceItem } from "@/routes/evergreen-model";
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

/** The in-page target of the "see customer photographs" link under the purchase buttons. */
const FEEDBACK_SECTION_ID = PRODUCT_FEEDBACK_ANCHOR;

const PANEL_LINK =
  "underline decoration-[#3B2219]/30 underline-offset-[5px] transition-colors hover:decoration-[#3B2219] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3B2219]";

function AssuranceIcon({ kind }: Readonly<{ kind: PurchaseAssuranceItem["key"] | "photos" }>) {
  const paths: Record<typeof kind, string> = {
    // Banknote.
    cod: "M3 7h18v10H3z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    // Two arrows turning back.
    returns: "M4 9h12a4 4 0 0 1 0 8H8 M7 6 4 9l3 3",
    // Delivery truck.
    "free-shipping": "M3 6h11v9H3z M14 9h4l3 3v3h-7 M7 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M17 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    // Camera.
    photos: "M4 8h3l2-2h6l2 2h3v11H4z M12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  };
  return (
    <svg
      aria-hidden="true"
      focusable={false}
      className="h-[18px] w-[18px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function render(data: ProductRouteData) {
  const { editorial } = data;

  // A product with its own review photographs shows those, not the shared brand gallery as well:
  // two walls of customer photographs say the same thing twice, and the shared one is not about this
  // product. The brand rail stays at the bottom of the page for a product with no review photographs;
  // nothing near the price points to it (no strip, no link under the buy buttons).
  const reviewsHavePhotos = data.reviews !== null && data.reviews.photoCount > 0;
  const feedback = data.feedback !== null && data.feedback.scope === "brand" && reviewsHavePhotos
    ? null
    : data.feedback;
  // The photographs under the price: this product's review photographs or its own tagged ones, and
  // nothing otherwise -- the shop's shared gallery shows only in its rail at the bottom of the page.
  // A product strip also carries the link the purchase panel used to hold, so that link steps aside
  // for it.
  const photoStrip = resolveCustomerPhotoStrip({
    reviews: data.reviews,
    feedback,
  });

  const identity = (
    <>
      <p className="eyebrow hidden lg:block">{BRAND.identity.name} / Sản phẩm</p>
      {/* Master spec §9: the product's name is a heading, so it wears the elegant serif the rest
          of the brand's headings wear rather than the condensed bold sans it used to shout in. */}
      <h1 className="mt-0 break-words font-display text-[28px] font-normal leading-[1.08] tracking-[-0.03em] sm:text-[30px] lg:mt-5 lg:text-[40px] lg:leading-[1.1]">
        {data.name}
      </h1>

      {/* Stars and the average once there are enough reviews, else just how many. */}
      {data.reviews === null ? null : <ProductRatingLink section={data.reviews} />}

      {data.collections.length > 0 ? (
        <div className="pdp-collection-row -mx-6 mt-3 flex gap-2 overflow-x-auto px-6 lg:mx-0 lg:mt-4 lg:flex-wrap lg:overflow-visible lg:px-0">
          {data.collections.map((collection) => (
            <Link
              key={collection.slug}
              href={`/collections/${collection.slug}`}
              className="badge badge--stone shrink-0 whitespace-nowrap transition-colors hover:border-black"
            >
              {collection.title}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );

  const hasProductInformation =
    editorial.description !== null
    || editorial.craftDetails.length > 0
    || editorial.material !== null
    || editorial.careInstructions !== null;

  // F7e: a product with no approved editorial facts gets no empty block to explain itself with.
  const productInformation = !hasProductInformation ? null : (
    <section aria-label="Chi tiết sản phẩm" className="border-t border-black/20">
      {editorial.description || editorial.craftDetails.length > 0 ? (
        <section className="border-b border-[#3B2219]/25 py-6" aria-labelledby="pdp-description-title">
          <h2 id="pdp-description-title" className="pdp-section-title font-display text-xl font-normal tracking-[-0.02em] lg:text-2xl">
            Mô tả sản phẩm
          </h2>
          {/* Below `lg` the description opens on its first lines; the blocks after it fold. */}
          <PdpClampedContent>
            {editorial.description ? (
              <p className="mt-3 max-w-xl whitespace-pre-line text-sm leading-6 text-black/70">{editorial.description}</p>
            ) : null}
            {editorial.craftDetails.length > 0 ? (
              <ul className="mt-3 max-w-xl list-disc space-y-1 pl-5 text-sm leading-6 text-black/70">
                {editorial.craftDetails.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </PdpClampedContent>
        </section>
      ) : null}

      {editorial.material ? (
        <PdpDisclosure titleId="pdp-material-title" title="Chất liệu">
          <p className="max-w-xl text-sm leading-6 text-black/70 lg:mt-3">{editorial.material}</p>
        </PdpDisclosure>
      ) : null}

      {/*
        The approved order includes "Thông số/fit", but current ProductContent has no dedicated,
        approved fit/measurement fact. Size options, category and craft details are not fit facts,
        so F7e truthfully omits the block until such a source exists.
      */}

      {editorial.careInstructions ? (
        <PdpDisclosure titleId="pdp-care-title" title="Hướng dẫn bảo quản">
          <p className="max-w-xl whitespace-pre-line text-sm leading-6 text-black/70 lg:mt-3">
            {editorial.careInstructions}
          </p>
        </PdpDisclosure>
      ) : null}
    </section>
  );

  const purchaseInformation = (
    <section
      aria-label="Giao hàng và đổi trả"
      // Below `lg` this stacks right under the product information, whose last row already closes
      // with a rule, so a second top rule would draw a doubled line.
      className={`border-black/20 lg:border-t ${hasProductInformation ? "" : "border-t"}`}
    >
      <PdpDisclosure titleId="pdp-shipping-title" title="Giao hàng">
        <div className="max-w-xl space-y-1 text-sm leading-6 text-black/70 lg:mt-3">
          <p>{data.shipping.coverage}</p>
          <p>{data.shipping.innerCityLabel}: {data.shipping.innerCityEstimate}</p>
          <p>{data.shipping.otherProvinceLabel}: {data.shipping.otherProvinceEstimate}</p>
          <p>{data.shipping.estimateCaveat}</p>
          <Link className="inline-block underline underline-offset-4" href="/shipping">
            Xem chính sách vận chuyển
          </Link>
        </div>
      </PdpDisclosure>

      <PdpDisclosure titleId="pdp-returns-title" title="Đổi trả">
        <div className="max-w-xl space-y-1 text-sm leading-6 text-black/70 lg:mt-3">
          <p>{data.returns.returnWindow}</p>
          <p>{data.returns.refundWindow}</p>
          <Link className="inline-block underline underline-offset-4" href="/returns">
            Xem chính sách đổi trả
          </Link>
        </div>
      </PdpDisclosure>
    </section>
  );

  // A shopper unsure of their size can ask the shop directly, beside the guide. Both links are
  // derived from approved contact facts, and either is omitted when it cannot be derived.
  const messengerHref = messengerUrlFromFanpage(BRAND.contact.fanpageUrl);
  const zaloHref = zaloUrlFromTelephone(BRAND.contact.telephone);
  const sizeHelp = messengerHref === null && zaloHref === null ? null : (
    <p className="flex flex-wrap items-center gap-x-3 text-sm text-[#3B2219]/70" data-pdp-size-help="">
      <span>Phân vân size? Hỏi shop qua</span>
      {messengerHref === null ? null : (
        <a
          className={`inline-flex min-h-11 items-center text-[#3B2219] ${PANEL_LINK}`}
          href={messengerHref}
          target="_blank"
          rel="noreferrer"
        >
          Messenger<span className="sr-only"> (mở trong tab mới)</span>
        </a>
      )}
      {zaloHref === null ? null : (
        <a
          className={`inline-flex min-h-11 items-center text-[#3B2219] ${PANEL_LINK}`}
          href={zaloHref}
          target="_blank"
          rel="noreferrer"
        >
          Zalo<span className="sr-only"> (mở trong tab mới)</span>
        </a>
      )}
    </p>
  );

  // Promotions this product takes part in, named under the price by the campaign's own name and
  // nothing else (owner request 2026-10-18). The cart quote computes them; the page states no amount,
  // threshold or explanation of its own.
  const purchaseOffers = data.promotionOffers.length === 0 && data.voucherTeaser.length === 0 ? null : (
    <>
      {data.promotionOffers.length === 0 ? null : (
        <ul aria-label="Ưu đãi áp dụng" className="mt-3 flex flex-col items-start gap-2" data-pdp-offers="">
          {/* The same ticket as the voucher chips below, so promotions and vouchers read as one family.
              A promotion is not a voucher type: the discount ticket takes the neutral ink tone, the gift the mocha one. */}
          {data.promotionOffers.map((offer) => (
            <li
              key={offer.id}
              className={`voucher-chip voucher-tone ${offer.kind === "GIFT" ? "voucher-tone--mocha" : "voucher-tone--ink"}`}
            >
              <span className="voucher-chip__icon"><VoucherIcon name={offer.kind === "GIFT" ? "gift" : "tag"} /></span>
              <span className="voucher-chip__text">{offer.label}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Voucher teaser: states the voucher's own conditions only; whether a cart qualifies is decided in the cart. */}
      {data.voucherTeaser.length === 0 ? null : (
        <div className="mt-5 text-sm text-[#3B2219]" data-pdp-vouchers="">
          <p className="pdp-voucher-label">Voucher có thể áp dụng cho giỏ hàng:</p>
          <VoucherTeaserChips items={data.voucherTeaser} />
        </div>
      )}
    </>
  );

  // The buying facts, repeated where the decision is made; the full policies stay further down.
  const purchaseAssurance = (
    <div className="mt-4 border-t border-[#3B2219]/15 pt-4">
      <ul aria-label="Cam kết mua hàng" className="space-y-2 text-sm text-[#3B2219]/80">
        {data.purchaseAssurance.map((item) => (
          <li key={item.key} className="flex items-center gap-2.5">
            <AssuranceIcon kind={item.key} />
            {item.href === null ? (
              <span>{item.label}</span>
            ) : (
              <Link className={PANEL_LINK} href={item.href}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {feedback === null || feedback.scope === "brand" || stripReplacesFeedbackLink(photoStrip) ? null : (
        <p className="mt-2 flex items-center gap-2.5 text-sm text-[#3B2219]/80">
          <AssuranceIcon kind="photos" />
          <a className={PANEL_LINK} href={`#${FEEDBACK_SECTION_ID}`}>
            {`Xem ${feedback.images.length} ảnh khách hàng diện mẫu này`}
          </a>
        </p>
      )}
    </div>
  );

  return (
    <>
      <span hidden data-pdp-root="" />
      <div
        id="san-pham"
        data-pdp-anchor=""
        className="collection-products-anchor"
      >
        <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
        <span id="chi-tiet" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
      </div>
      <BrandProductDetail
        selection={{
          slug: data.slug,
          productName: data.name,
          options: data.options,
          productLevelOptions: data.productLevelOptions,
          initialSelection: data.deepLinkedSelection,
          commerceTrackingEnabled: data.commerceTrackingEnabled,
          colorDimensionLabel: data.colorDimensionLabel,
        }}
        media={data.media}
        video={data.video}
        productName={data.name}
        galleryIndexByVariantId={data.galleryIndexByVariantId}
        sizeGuide={editorial.sizeGuide}
        tryOn={data.tryOn}
        identity={identity}
        productInformation={productInformation}
        purchaseInformation={purchaseInformation}
        sizeHelp={sizeHelp}
        sizeGuideZaloHref={zaloHref}
        purchaseAssurance={purchaseAssurance}
        purchaseOffers={
          photoStrip === null ? (
            purchaseOffers
          ) : (
            <>
              <CustomerPhotoStrip strip={photoStrip} />
              {purchaseOffers}
            </>
          )
        }
        urgency={data.urgency}
      />

      {data.reviews === null ? null : (
        <ProductReviews
          section={data.reviews}
          photoRail={
            data.reviews.photos.length === 0 ? null : (
              <FeedbackRail
                id={PRODUCT_REVIEW_PHOTOS_ANCHOR}
                headingId="pdp-review-photos-title"
                surface="product"
                title="Ảnh khách diện mẫu này"
                ctaLabel="Xem thêm"
                href={null}
                images={data.reviews.photos.map((photo) => ({
                  src: photo.src,
                  alt: photo.alt,
                  width: null,
                  height: null,
                }))}
              />
            )
          }
        />
      )}

      {feedback === null ? null : (
        // A full-bleed linen band, so the customers' photographs, the page's strongest proof, set the rhythm.
        <div className="pdp-feedback-band">
          <FeedbackRail
            id={FEEDBACK_SECTION_ID}
            headingId="pdp-feedback-title"
            surface="product"
            title={feedback.title}
            ctaLabel={feedback.ctaLabel}
            href={feedback.href}
            images={feedback.images}
          />
        </div>
      )}

      {data.relatedCards.length > 0 ? (
        <div className="mx-auto max-w-[1600px] px-6 pb-16">
          <section aria-labelledby="related-products-title" className="border-t border-black/20 pt-6">
            <div className="section-heading-row section-heading-row--center">
              {/*
                The generic related source is manual overrides or a same-category fallback. Neither
                proves the items complete an outfit, so the heading says what the data supports.
              */}
              <h2 id="related-products-title">Nàng có thể thích</h2>
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
