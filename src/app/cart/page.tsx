import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import { BrandCartLineControls } from "@/components/brand/cart-line-controls";
import { BrandCartGiftPicker } from "@/components/brand/cart-gift-picker";
import { CartLineJumpLink } from "@/components/brand/cart-line-jump-link";
import { MobileStickyCta } from "@/components/brand/mobile-sticky-cta";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { LinePrice } from "@/components/brand/line-price";
import { OrderSummary } from "@/components/brand/order-summary";
import { PromotionBanner, PromotionSavings } from "@/components/brand/promotion-banner";
import { BrandPreorderFulfillmentNotice } from "@/components/brand/preorder-fulfillment-notice";
import { loadCartRoute, type CartRouteProps } from "@/routes/cart";
import type { CartLineView, CartViewModel } from "@/routes/cart-model";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCartMetadata } from "@/routes/metadata/cart";

/** Markup only. The lines, the subtotal and the `view_cart` event live in `@/routes/cart`. */

const CART_BREADCRUMBS = [{ label: "Trang chủ", href: "/" }, { label: "Giỏ hàng" }] as const;
const CHECKOUT_CTA_ID = "cart-checkout-cta";
const lineAnchor = (line: CartLineView) => `cart-line-${line.variantId}`;

function LineVisual({ line, priority }: Readonly<{ line: CartLineView; priority: boolean }>) {
  return (
    <div className="relative aspect-[3/4] w-full overflow-hidden bg-black/[0.04]">
      {line.primaryImage ? (
        <Image
          alt={line.primaryImage.alt}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          fill
          priority={priority}
          sizes="(max-width: 640px) 144px, 176px"
          src={line.primaryImage.url}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center p-4 text-center text-xs font-semibold uppercase tracking-[0.1em] text-black/75"
          aria-hidden="true"
        >
          {BRAND.identity.name}
        </div>
      )}
    </div>
  );
}

function render(data: CartViewModel) {
  if (data.isEmpty) {
    return (
      <PageShell>
        <PageBreadcrumbs items={CART_BREADCRUMBS} />
        <PageHeader eyebrow="Mua sắm" title="Giỏ hàng" />
        <div className="mt-8" data-ui-state="empty">
          <p className="font-display text-xl md:text-2xl">Giỏ hàng của bạn đang trống.</p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Khám phá các thiết kế mới nhất trong bộ sưu tập của chúng tôi.
          </p>
          {data.gifts ? <BrandCartGiftPicker model={data.gifts} /> : null}
          <Link className="text-link mt-6 inline-block" href="/shop">Tiếp tục mua sắm ↗</Link>
        </div>
      </PageShell>
    );
  }

  // The earned-gift banner was a second, anchor-only "Chọn quà" action. The actual picker
  // now owns that message and action above the paid lines; other promotion progress stays visible.
  const hasGiftPicker = Boolean(data.gifts && (
    data.gifts.selections.length > 0 ||
    data.gifts.campaigns.some((campaign) => campaign.entitled > 0)
  ));
  const promotions = hasGiftPicker && data.promotions
    ? {
        ...data.promotions,
        items: data.promotions.items.filter(
          (item) => !(item.kind === "GIFT" && item.state === "achieved"),
        ),
      }
    : data.promotions;
  const problemLines = data.lines.filter((line) => !line.available);

  return (
    <PageShell>
      <PageBreadcrumbs items={CART_BREADCRUMBS} />
      <PageHeader eyebrow="Mua sắm" title="Giỏ hàng" meta={`${data.lineCount} sản phẩm`} />
      <div className="mt-8 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.34fr)] lg:gap-16">
        <div className="min-w-0">
          {data.gifts ? <BrandCartGiftPicker model={data.gifts} /> : null}
          <PromotionBanner className="mb-5" view={promotions} />
          <div className="divide-y divide-black/15">
            {data.lines.map((line, index) => (
              <article
                className="grid scroll-mt-32 gap-6 py-8 outline-offset-4 first:pt-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black sm:grid-cols-[9rem_minmax(0,1fr)] md:grid-cols-[11rem_minmax(0,1fr)]"
                id={lineAnchor(line)}
                key={line.variantId}
                tabIndex={line.available ? undefined : -1}
                aria-label={line.available ? undefined : `${line.productName}, cần xử lý: ${line.availabilityLabel}`}
              >
                <div>
                  {line.productSlug ? (
                    <Link
                      className="group block overflow-hidden border border-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                      href={`/shop/${encodeURIComponent(line.productSlug)}`}
                      aria-label={`Xem ${line.productName}`}
                    >
                      <LineVisual line={line} priority={index === 0} />
                    </Link>
                  ) : (
                    <div className="overflow-hidden border border-black/10">
                      <LineVisual line={line} priority={index === 0} />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      {line.productSlug ? (
                        <Link
                          className="text-lg font-semibold uppercase tracking-[0.06em] underline underline-offset-4 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                          href={`/shop/${encodeURIComponent(line.productSlug)}`}
                        >
                          {line.productName}
                        </Link>
                      ) : (
                        <h2 className="text-lg font-semibold uppercase tracking-[0.06em]">{line.productName}</h2>
                      )}
                      <p className="mt-2 text-sm text-black/75">{line.optionLabel}</p>
                      {line.paidSegments ? <p className="mt-2 text-sm">Giá sau ưu đãi: {line.paidSegments.join(" + ")}</p> : null}
                      {/* §30 — the marker has to survive the trip from the PDP, so it rides the line
                          it belongs to rather than only the basket-level notice below. */}
                      {line.preorderLabel === null ? null : (
                        <p
                          className="mt-2 inline-flex items-center border border-black px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.12em]"
                          data-line-state="preorder"
                        >
                          {line.preorderLabel}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      {/* The per-product sale stays on the line whatever else applies; a quantity or order-value
                          price is the breakdown beside the name, never a replacement for it. */}
                      <p className="font-medium">
                        <LinePrice
                          discountPercent={line.discountPercent}
                          originalPriceText={line.originalPriceText}
                          priceText={line.priceText}
                        />
                      </p>
                      <p className={`mt-1 text-xs uppercase tracking-[0.12em] ${line.available ? "text-black/70" : "font-semibold text-black"}`} data-line-problem={line.available ? undefined : ""}>
                        {line.available ? line.availabilityLabel : `Cần xử lý: ${line.availabilityLabel}`}
                      </p>
                    </div>
                  </div>
                  <BrandCartLineControls
                    variantId={line.variantId}
                    initialQuantity={line.quantity}
                    canUpdate={line.canUpdate}
                    commerceTrackingEnabled={data.commerceTrackingEnabled}
                  />
                </div>
              </article>
            ))}
          </div>
        </div>
        <aside className="h-fit border-t border-black pt-6 lg:sticky lg:top-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em]">Tóm tắt</p>
          {data.summary ? (
            <OrderSummary className="mt-5" summary={data.summary} />
          ) : (
            <>
            <div className="mt-5 flex items-baseline justify-between gap-6 border-b border-black/15 pb-5">
              <span className="text-sm text-black/75">
                {data.hasUnavailableLines ? "Tạm tính khả dụng" : "Tạm tính"}
              </span>
              <strong className="text-xl font-medium tracking-[-0.02em]">{data.subtotalText}</strong>
            </div>
            <PromotionSavings className="mt-4" rows={data.promotions?.savings} />
            {data.shippingBaseFeeText ? (
              <div className="mt-4 flex items-baseline justify-between gap-6 text-sm" data-cart-shipping-estimate>
                <span className="text-black/75">Phí vận chuyển (tạm tính)</span>
                <span>{data.shippingBaseFeeText}</span>
              </div>
            ) : null}
            </>
          )}
          {data.hasUnavailableLines ? (
            <p className="mt-4 text-sm leading-6 text-black/75">
              Sản phẩm không khả dụng không được tính vào tạm tính. Bạn có thể giảm số lượng khi tồn kho không đủ hoặc xóa dòng khỏi giỏ hàng.
            </p>
          ) : null}
          <p className="mt-4 text-sm leading-6 text-black/75">
            {data.summary
              ? "Giá, tồn kho và phí vận chuyển sẽ được kiểm tra lại trước khi tạo đơn."
              : data.shippingBaseFeeText
                ? "Phí vận chuyển chính xác sẽ hiện ở bước thanh toán."
                : "Giá và tồn kho hiện tại sẽ được kiểm tra lại trước khi tạo đơn. Phí vận chuyển chưa được cộng ở đây."}
          </p>
          {data.preorderNotice === null ? null : (
            <BrandPreorderFulfillmentNotice
              notice={data.preorderNotice}
              titleId="preorder-fulfillment-title"
            />
          )}
          {data.canCheckout ? (
            <Link
              className="btn btn--primary mt-7 w-full"
              href="/checkout"
              id={CHECKOUT_CTA_ID}
            >
              Tiến hành đặt hàng
            </Link>
          ) : data.benefitsNotice || problemLines.length === 0 ? (
            <p className="mt-6 border border-black/20 px-4 py-3 text-sm leading-6 text-black/75">
              {data.benefitsNotice ?? "Hãy xử lý các dòng chưa khả dụng trước khi thanh toán."}
            </p>
          ) : (
            /* UX-08 / AC-19: every line that blocks checkout, by name and reason, each a way to that line. */
            <div className="mt-6 border border-black/20 px-4 py-3 text-sm leading-6" data-cart-problem-lines>
              <p className="font-semibold">
                {`Nàng xem lại ${problemLines.length} sản phẩm trước khi đặt hàng nhé:`}
              </p>
              <ul className="mt-2 space-y-1">
                {problemLines.map((line) => (
                  <li key={line.variantId}>
                    <CartLineJumpLink targetId={lineAnchor(line)}>{`${line.productName} — ${line.availabilityLabel}`}</CartLineJumpLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link className="text-link mt-7 inline-block" href="/shop">Tiếp tục mua sắm ↗</Link>
        </aside>
      </div>
      {data.canCheckout ? (
        <>
          {/* Room for the bottom bar, so it never sits over the end of the page. */}
          <div aria-hidden="true" className="h-24 lg:hidden" />
          <MobileStickyCta targetId={CHECKOUT_CTA_ID} totalText={data.summary?.totalText ?? data.subtotalText}>
            <Link className="btn btn--primary px-4" href="/checkout">Thanh toán</Link>
          </MobileStickyCta>
        </>
      ) : null}
    </PageShell>
  );
}

const route = createStorefrontRoute<CartRouteProps, CartViewModel>({ load: loadCartRoute, render });

export const metadata = buildCartMetadata();
export default route.Page;
