import type { Metadata } from "next";
import Link from "next/link";

import {
  describeGuestShippingPromotion,
  readGuestShippingPolicy,
} from "@/commerce/guest-shipping-policy";
import {
  buildPublicBrandFacts,
  describePublicDeliveryEstimate,
  PUBLIC_DELIVERY_FACTS,
  PUBLIC_RETURNS_POLICY,
} from "@/content/public-brand-facts";
import { BRAND } from "@/brand";
import { PUBLIC_DELIVERY_SCOPE_LABELS } from "@/content/public-fulfillment-facts";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type ShippingPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: ShippingPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/shipping",
    searchParams: await searchParams,
    title: "Chính sách vận chuyển và thanh toán",
    description:
      `Phạm vi giao hàng, đơn vị vận chuyển, thời gian dự kiến và phương thức thanh toán của ${BRAND.identity.name}.`,
  });
}

/**
 * W13/U33b + U41/M5 — Shipping & Payment page from reviewed public authorities.
 *
 * Shipping price remains server-owned in `readGuestShippingPolicy`. Delivery windows stay in
 * `PUBLIC_DELIVERY_FACTS`, while `PUBLIC_DELIVERY_SCOPE_LABELS` names the owner-approved Hanoi
 * scopes explicitly so the public page does not publish the ambiguous historical labels “Nội thành”
 * and “Ngoại tỉnh”. No Merchant-only fallback changes the customer-facing delivery policy.
 */
export default function ShippingPage() {
  const policy = readGuestShippingPolicy();
  const promotion = describeGuestShippingPromotion(policy);
  const brandFacts = buildPublicBrandFacts(policy);
  const {
    coverage,
    carriers,
    estimateDays,
    estimateCaveat,
    carrierTrackingNote,
    phoneConfirmationWording,
  } = PUBLIC_DELIVERY_FACTS;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Chính sách</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Vận chuyển &amp; thanh toán
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8">{coverage}.</p>

      <div className="mt-16 grid max-w-4xl gap-14">
        <section aria-labelledby="delivery-heading">
          <h2 id="delivery-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Giao hàng
          </h2>
          <dl className="mt-6 grid max-w-2xl gap-6 text-base leading-7">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                Đơn vị vận chuyển
              </dt>
              <dd className="mt-2 text-black/70">{carriers.join(" · ")}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {PUBLIC_DELIVERY_SCOPE_LABELS.innerCity}
              </dt>
              <dd className="mt-2 text-black/70">
                {describePublicDeliveryEstimate(estimateDays.innerCity)} (dự kiến)
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {PUBLIC_DELIVERY_SCOPE_LABELS.otherProvince}
              </dt>
              <dd className="mt-2 text-black/70">
                {describePublicDeliveryEstimate(estimateDays.otherProvince)} (dự kiến)
              </dd>
            </div>
          </dl>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">{estimateCaveat}</p>
        </section>

        <section aria-labelledby="fee-heading">
          <h2 id="fee-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Phí vận chuyển
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {promotion.title}: {promotion.detail} Phí vận chuyển và điều kiện miễn phí được máy chủ
            áp dụng tại thời điểm đặt hàng.
          </p>
        </section>

        <section aria-labelledby="tracking-heading">
          <h2 id="tracking-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Theo dõi đơn hàng
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {carrierTrackingNote} {brandFacts.orderTracking.detail}{" "}
            <Link
              className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
              href="/track-order"
            >
              {brandFacts.orderTracking.title}
            </Link>
            . {phoneConfirmationWording}
          </p>
        </section>

        <section aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Thanh toán
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7">{brandFacts.paymentMethod}</p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {brandFacts.checkoutAccount} {brandFacts.serverVerification}
          </p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {PUBLIC_RETURNS_POLICY.refundChannelNote} Điều kiện và thời gian hoàn tiền được nêu trong{" "}
            <Link
              className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
              href="/returns"
            >
              chính sách đổi trả
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
