import { ShippingPromotionNoticeView } from "@/components/brand/shipping-promotion-notice";
import Link from "@/components/brand/localized-link";

import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute, type RequestI18n } from "@/routes/factory";
import { loadShippingRoute, type ShippingRouteProps } from "@/routes/shipping";
import type { ShippingViewModel } from "@/routes/evergreen-model";
import { buildShippingMetadata } from "@/routes/metadata/shipping";

/**
 * W13/U33b + U41/M5 — Shipping & Payment page from reviewed public authorities.
 *
 * Shipping price remains server-owned in `readGuestShippingPolicy`, which the loader reads.
 * Delivery windows stay in `PUBLIC_DELIVERY_FACTS`, and `FULFILLMENT.deliveryScopeLabels` names the
 * approved split — Hà Nội, and everywhere else — so the page publishes neither the ambiguous bare
 * “Ngoại tỉnh” nor an inner-city framing that would narrow the 1–3 day window to part of the city.
 * No Merchant-only fallback changes the customer-facing delivery policy. Page prose labels
 * sections; every normative statement is a fact.
 *
 * A5 added the payment section's second sentence: bank transfer is temporarily unavailable, in the
 * approved words. Its `thanh-toan` anchor is the destination the policy hub links to.
 */

const POLICY_LINK =
  "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: ShippingViewModel, { t }: RequestI18n) {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Vận chuyển & thanh toán" }]} />
      <PageHeader
        eyebrow={t("Chính sách")}
        title={t("Vận chuyển & thanh toán")}
        lead={<>{t(data.coverage)}.</>}
      />

      <div className="mt-10 grid max-w-4xl gap-14">
        <section aria-labelledby="delivery-heading">
          <h2 id="delivery-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Giao hàng")}
          </h2>
          <dl className="mt-6 grid max-w-2xl gap-6 text-base leading-7">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {t("Đơn vị vận chuyển")}
              </dt>
              <dd className="mt-2 text-black/70">
                {t(data.carriersText)}
                <span className="mt-1 block text-sm text-black/60">{t(data.carrierSelectionNote)}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {t(data.innerCityLabel)}
              </dt>
              <dd className="mt-2 text-black/70">{t("{estimate} (dự kiến)", { estimate: t(data.innerCityEstimate) })}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {t(data.otherProvinceLabel)}
              </dt>
              <dd className="mt-2 text-black/70">{t("{estimate} (dự kiến)", { estimate: t(data.otherProvinceEstimate) })}</dd>
            </div>
          </dl>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">{t(data.estimateCaveat)}</p>
        </section>

        <section aria-labelledby="fee-heading">
          <h2 id="fee-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Phí vận chuyển")}
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {t(data.shippingPromotionTitle)}: {t(data.shippingPromotionDetail)}{" "}
            {t("Phí vận chuyển và điều kiện miễn phí được máy chủ áp dụng tại thời điểm đặt hàng.")}
          </p>
          <ShippingPromotionNoticeView initial={data.activeShippingPromotion} />
        </section>

        <section aria-labelledby="tracking-heading">
          <h2 id="tracking-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Theo dõi đơn hàng")}
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {t(data.carrierTrackingNote)} {t(data.orderTrackingDetail)}{" "}
            <Link className={POLICY_LINK} href="/track-order">
              {t(data.orderTrackingTitle)}
            </Link>
            . {t(data.phoneConfirmationWording)}
          </p>
        </section>

        {/* `thanh-toan` is the anchor the policy hub links to; it is part of the published surface. */}
        <section id="thanh-toan" aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Thanh toán")}
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7">{t(data.paymentMethod)}</p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {t(data.bankTransferUnavailable)}
          </p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {t(data.checkoutAccount)} {t(data.serverVerification)}
          </p>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {t(data.refundChannelNote)} {t("Điều kiện và thời gian hoàn tiền được nêu trong")}{" "}
            <Link className={POLICY_LINK} href="/returns">
              {t("chính sách đổi trả")}
            </Link>
            .
          </p>
        </section>
      </div>
    </PageShell>
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
