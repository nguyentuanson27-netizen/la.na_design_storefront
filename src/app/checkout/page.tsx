import Image from "next/image";
import Link from "next/link";

import { BrandGuestCheckoutForm } from "@/components/brand/guest-checkout-form";
import { PageHeader, PageShell } from "@/components/brand/page-chrome";
import { LinePrice } from "@/components/brand/line-price";
import { OrderSummary } from "@/components/brand/order-summary";
import { PromotionBanner } from "@/components/brand/promotion-banner";
import { BrandPreorderFulfillmentNotice } from "@/components/brand/preorder-fulfillment-notice";
import { createStorefrontRoute } from "@/routes/factory";
import { loadCheckoutRoute, type CheckoutRouteProps } from "@/routes/checkout";
import type { CheckoutViewModel } from "@/routes/checkout-model";
import { buildCheckoutMetadata } from "@/routes/metadata/checkout";

/** Checkout's markup. Every decision behind it is in `@/routes/checkout` and its model. */

// No breadcrumb or eyebrow: checkout keeps the buyer on the form, not on the way out.
function render(data: CheckoutViewModel) {
  const bankTransferEnabled = data.bankTransferEnabled === true;
  if (data.state === "empty") {
    return (
      <PageShell>
        <PageHeader title="Thanh toán" />
        <div className="mt-8" data-ui-state="empty">
          <p className="font-display text-xl md:text-2xl">Giỏ hàng của nàng đang trống.</p>
          <Link className="text-link mt-6 inline-block" href="/shop">Tiếp tục mua sắm ↗</Link>
        </div>
      </PageShell>
    );
  }

  const { lines, quoteProof } = data;
  const totals = data.totals ?? { subtotalText: "Chưa thể tính", shippingText: "Chưa thể tính", totalText: "Chờ kiểm tra báo giá" };
  const benefit = data.benefit;
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0) + (benefit?.giftQuantity ?? data.giftPicker?.selections.reduce((count, row) => count + row.quantity, 0) ?? 0);

  const orderLines = (
    <div className="divide-y divide-black/15 border-b border-black/15">
      {lines.map((line) => (
        <div className="flex items-start gap-4 py-4 first:pt-0" data-line-role="paid" key={line.lineKey}>
          <div className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden border border-black/10 bg-black/[0.04]">
            {line.primaryImage ? (
              <Image
                alt={line.primaryImage.alt}
                className="h-full w-full object-cover"
                fill
                sizes="56px"
                src={line.primaryImage.url}
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center text-[9px] font-semibold uppercase tracking-wider text-black/75"
                aria-hidden="true"
              >
                LA
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold uppercase tracking-[0.05em]">{line.productName}</p>
            <p className="mt-1 text-xs leading-5 text-black/75">
              {line.optionLabel} · SL {line.quantity}
              {line.unitPriceText === null || line.originalPriceText ? null : ` × ${line.unitPriceText}`}
            </p>
            {line.originalPriceText ? (
              <p className="mt-1 text-xs leading-5 text-black/75">
                <LinePrice
                  discountPercent={line.discountPercent}
                  originalPriceText={line.originalPriceText}
                  priceText={line.promotionPriceText ?? line.unitPriceText ?? ""}
                />
                {line.promotionPriceText && line.unitPriceText ? (
                  <span className="ml-1.5" data-line-after-offers>
                    · Giá sau ưu đãi: {line.unitPriceText}
                  </span>
                ) : null}
              </p>
            ) : null}
            {line.preorderLabel === null ? null : (
              <p
                className="mt-1 inline-flex items-center border border-black px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em]"
                data-line-state="preorder"
              >
                {line.preorderLabel}
              </p>
            )}
          </div>
          <p className="shrink-0 text-sm font-medium">{line.lineTotalText}</p>
        </div>
      ))}
      {(benefit?.giftLines ?? data.giftPicker?.selections.map((row) => ({ lineKey: `${row.campaignId}/${row.variantId}`, label: row.label, quantity: row.quantity, priceText: "Cần kiểm tra", imageUrl: row.imageUrl ?? null })) ?? []).map((gift) => (
        <div className="flex items-start gap-4 py-4" data-line-role="gift" key={gift.lineKey}>
          {gift.imageUrl ? (
            <div className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden border border-black/10 bg-black/[0.04]">
              <Image alt="" className="h-full w-full object-cover" fill sizes="56px" src={gift.imageUrl} />
            </div>
          ) : (
            <div
              className="flex aspect-[3/4] w-14 shrink-0 items-center justify-center border border-black/10 bg-black/[0.04] text-[9px] font-semibold uppercase tracking-wider text-black/75"
              aria-hidden="true"
            >
              Quà
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold uppercase tracking-[0.05em]">{gift.label}</p>
            <p className="mt-1 text-xs leading-5 text-black/75">Quà tặng · SL {gift.quantity}</p>
          </div>
          <p className="shrink-0 text-sm font-medium">{gift.priceText}</p>
        </div>
      ))}
    </div>
  );

  // The older block is only the fallback for a quote the bill below could not be made to add up for, so a
  // shopper never sees lines that do not sum to the total. "Tạm tính" is already net of every cart-level
  // discount, so no saving is printed beneath it: that would take the same discount off twice.
  const fallbackTotals = (
    <dl className="space-y-3 text-sm">
      <div className="flex justify-between gap-5">
        <dt className="text-black/75">Tạm tính</dt>
        <dd>{totals.subtotalText}</dd>
      </div>
      {benefit && benefit.giftQuantity > 0 ? (
        <div className="flex justify-between gap-5">
          <dt className="text-black/75">Quà tặng ({benefit.giftQuantity})</dt>
          <dd>0 ₫</dd>
        </div>
      ) : null}
      <div className="flex justify-between gap-5">
        <dt className="text-black/75">Phí vận chuyển</dt>
        <dd>{totals.shippingText}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-5 border-t border-black pt-4">
        <dt className="font-semibold uppercase tracking-[0.08em]">Tổng thanh toán</dt>
        <dd className="text-xl font-semibold tracking-[-0.02em]">{totals.totalText}</dd>
      </div>
    </dl>
  );

  // The bill in reading order: value, each discount, shipping, total.
  const totalsBlock = (
    data.summary ? <OrderSummary summary={data.summary} /> : fallbackTotals
  );

  const summaryContent = (
    <>
      {orderLines}
      <Link
        className="mt-4 inline-block text-xs font-semibold uppercase tracking-[0.1em] underline underline-offset-4"
        href="/cart"
      >
        Sửa giỏ hàng
      </Link>
    </>
  );

  const totalsContent = totalsBlock;

  const preorderNoticeFor = (surface: "mobile" | "desktop") => data.preorderNotice === null ? null : <BrandPreorderFulfillmentNotice notice={data.preorderNotice} titleId={`preorder-fulfillment-title-${surface}`} />;

  return (
    <PageShell>
      <PageHeader title="Thanh toán" meta={bankTransferEnabled ? "Thanh toán khi nhận hàng hoặc chuyển khoản" : "Thanh toán khi nhận hàng"} />

      {/* The form owns one interactive gift area and the responsive order/receiving layout. */}
      <PromotionBanner className="mt-8" view={data.promotions} />
      <div className="mt-8">
        <BrandGuestCheckoutForm
          quoteProof={quoteProof}
          totalVnd={data.totals?.totalVnd}
          totalText={data.totals?.totalText}
          giftPicker={data.giftPicker}
          attemptKey={data.attemptKey}
          quoteRenderId={data.quoteRenderId}
          unavailableNotice={data.state === "unquotable" ? data.unavailableNotice ?? "Có sản phẩm, giá hoặc tồn kho cần được kiểm tra lại trước khi đặt hàng." : null}
          upsell={data.upsell}
          benefit={
            benefit === null
              ? undefined
              : {
                  digest: benefit.digest,
                  needsAcknowledgement: benefit.needsAcknowledgement,
                  unclaimedText: benefit.unclaimedText,
                  acknowledgementLabel: benefit.acknowledgementLabel,
                  tierNotice: benefit.tierNotice,
                }
          }
          summaryLabel={`Đơn hàng (${itemCount}) · ${totals.totalText}`}
          summarySlot={summaryContent}
          totalsSlot={totalsContent}
          preorderSlot={preorderNoticeFor("mobile")}
          desktopPreorderSlot={preorderNoticeFor("desktop")}
          bankTransferEnabled={bankTransferEnabled}
        />


      </div>
    </PageShell>
  );
}

const route = createStorefrontRoute<CheckoutRouteProps, CheckoutViewModel>({
  load: loadCheckoutRoute,
  render,
});

export const metadata = buildCheckoutMetadata();
export default route.Page;
