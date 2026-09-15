import Link from "next/link";

import { createStorefrontRoute } from "@/routes/factory";
import { loadShippingRoute, type ShippingRouteProps } from "@/routes/shipping";
import type { ShippingViewModel } from "@/routes/evergreen-model";
import { buildShippingMetadata } from "@/routes/metadata/shipping";

/**
 * W13/U33b + U41/M5 — Shipping & Payment page from reviewed public authorities.
 *
 * Shipping price remains server-owned in `readGuestShippingPolicy`, which the loader reads.
 * Delivery windows stay in `PUBLIC_DELIVERY_FACTS`, while `FULFILLMENT.deliveryScopeLabels` names
 * the owner-approved Hanoi scopes explicitly so the public page does not publish the ambiguous
 * historical labels “Nội thành” and “Ngoại tỉnh”. No Merchant-only fallback changes the
 * customer-facing delivery policy. Page prose labels sections; every normative statement is a fact.
 */

const POLICY_LINK =
  "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: ShippingViewModel) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Chính sách</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Vận chuyển &amp; thanh toán
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8">{data.coverage}.</p>

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
              <dd className="mt-2 text-black/70">{data.carriersText}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {data.innerCityLabel}
              </dt>
              <dd className="mt-2 text-black/70">{data.innerCityEstimate} (dự kiến)</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {data.otherProvinceLabel}
              </dt>
              <dd className="mt-2 text-black/70">{data.otherProvinceEstimate} (dự kiến)</dd>
            </div>
          </dl>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">{data.estimateCaveat}</p>
        </section>

        <section aria-labelledby="fee-heading">
          <h2 id="fee-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Phí vận chuyển
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {data.shippingPromotionTitle}: {data.shippingPromotionDetail} Phí vận chuyển và điều kiện miễn phí được máy chủ
            áp dụng tại thời điểm đặt hàng.
          </p>
        </section>

        <section aria-labelledby="tracking-heading">
          <h2 id="tracking-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Theo dõi đơn hàng
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {data.carrierTrackingNote} {data.orderTrackingDetail}{" "}
            <Link className={POLICY_LINK} href="/track-order">
              {data.orderTrackingTitle}
            </Link>
            . {data.phoneConfirmationWording}
          </p>
        </section>

        <section aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Thanh toán
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7">{data.paymentMethod}</p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {data.checkoutAccount} {data.serverVerification}
          </p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {data.refundChannelNote} Điều kiện và thời gian hoàn tiền được nêu trong{" "}
            <Link className={POLICY_LINK} href="/returns">
              chính sách đổi trả
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}

const route = createStorefrontRoute<ShippingRouteProps, ShippingViewModel>({
  load: loadShippingRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildShippingMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
