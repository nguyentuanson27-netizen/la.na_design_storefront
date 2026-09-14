import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";

import { BRAND } from "@/brand";
import { readAuthServerConfig } from "@/auth/config";
import { buildRenderedCheckoutQuoteFacts } from "@/commerce/checkout-quote";
import { issueRenderedQuoteProof } from "@/commerce/checkout-quote-proof";
import { getCurrentStorefrontCheckoutContext } from "@/commerce/storefront-cart-runtime";
import { buildCheckoutBeginEvent } from "@/components/analytics/cart-funnel-tracking";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { FacebookPixelEvent } from "@/components/analytics/facebook-pixel-event";
import { GuestCheckoutForm } from "@/components/commerce/guest-checkout-form";

export const metadata: Metadata = {
  title: "Thanh toán",
  description: `Thanh toán COD không cần tài khoản tại ${BRAND.identity.name}.`,
};

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export default async function CheckoutPage() {
  await connection();
  const checkoutContext = await getCurrentStorefrontCheckoutContext();

  if (!checkoutContext || checkoutContext.lines.length === 0) {
    return (
      <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
        <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
          <ol className="flex items-center gap-2">
            <li>
              <Link
                className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                href="/"
              >
                Trang chủ
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link
                className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                href="/cart"
              >
                Giỏ hàng
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-black font-medium">
              Thanh toán
            </li>
          </ol>
        </nav>
        <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          THANH TOÁN
        </h1>
        <div className="mt-12 border-t border-black/20 pt-8" data-ui-state="empty">
          <p className="font-serif text-2xl md:text-3xl">Giỏ hàng của bạn đang trống.</p>
          <Link className="text-link mt-6 inline-block" href="/shop">
            Tiếp tục mua sắm ↗
          </Link>
        </div>
      </div>
    );
  }

  const { cartId, lines } = checkoutContext;
  const totals = buildRenderedCheckoutQuoteFacts(lines);
  // Issued over exactly the facts rendered below, bound to the cart the cookie names. Submission
  // recomputes this quote server-side and refuses to create a submit-capable DRAFT unless this
  // token still describes it, so what the buyer sees here is what they can be charged.
  //
  // It comes back null when these facts cannot produce a token within the verifier's envelope,
  // which a long enough mirrored external id can cause. Quoting anyway would hand the buyer a proof
  // every submission rejects as oversized — a reconfirm loop no retry escapes — so an unprovable
  // cart is refused here alongside an unpriceable one.
  const quoteProof = totals
    ? issueRenderedQuoteProof({ quote: totals, cartId, secret: readAuthServerConfig().secret })
    : null;
  if (!totals || !quoteProof) {
    return (
      <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
        <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
          <ol className="flex items-center gap-2">
            <li>
              <Link
                className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                href="/"
              >
                Trang chủ
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link
                className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                href="/cart"
              >
                Giỏ hàng
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-black font-medium">
              Thanh toán
            </li>
          </ol>
        </nav>
        <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          THANH TOÁN
        </h1>
        <div className="mt-12 max-w-2xl border-t border-black/20 pt-8" data-ui-state="empty">
          <p className="font-serif text-2xl md:text-3xl">Giỏ hàng cần được kiểm tra lại.</p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Có sản phẩm, giá hoặc tồn kho chưa sẵn sàng để đặt hàng. Hãy quay lại giỏ hàng để cập nhật trước khi tiếp tục.
          </p>
          <Link className="text-link mt-6 inline-block" href="/cart">
            Quay lại giỏ hàng ↗
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
        <ol className="flex items-center gap-2">
          <li>
            <Link
              className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              href="/"
            >
              Trang chủ
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link
              className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              href="/cart"
            >
              Giỏ hàng
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black font-medium">
            Thanh toán
          </li>
        </ol>
      </nav>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <h1 className="text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          THANH TOÁN
        </h1>
        <p className="pb-2 text-xs uppercase tracking-[0.14em] text-black/70">Thanh toán khi nhận hàng</p>
      </div>

      <div className="mt-12 grid gap-12 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)] lg:gap-16">
        <GuestCheckoutForm quoteProof={quoteProof} />
        {/* Emitted only on this branch: the quote gate above already established that every line
            resolved, priced and had sufficient stock. Analytics never gates checkout itself — an
            unavailable projection suppresses the event and changes nothing else. */}
        <CommerceEventReporter event={buildCheckoutBeginEvent(lines)} />
        <FacebookPixelEvent
          name="InitiateCheckout"
          parameters={{
            // Every line gets an id, falling back to the variant when a product mirror has since
            // gone: dropping a line here while `value` and `num_items` still count it would report
            // an item list that contradicts its own totals.
            content_ids: lines.map((line) => line.productSlug ?? line.variantId),
            content_type: "product",
            currency: "VND",
            value: totals.totalVnd,
            num_items: totals.totalQuantity,
          }}
        />

        <aside className="h-fit border-t border-black pt-6 lg:sticky lg:top-24">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">Đơn hàng</p>
            <Link
              className="text-xs font-semibold uppercase tracking-[0.1em] underline underline-offset-4 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              href="/cart"
            >
              Sửa giỏ hàng
            </Link>
          </div>

          <div className="mt-6 divide-y divide-black/15 border-b border-black/15">
            {lines.map((line) => {
              const primaryImage = line.media.primary;
              return (
                <div className="flex items-start gap-4 py-4 first:pt-0" key={line.variantId}>
                  <div className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden border border-black/10 bg-black/[0.04]">
                    {primaryImage ? (
                      <Image
                        alt={primaryImage.alt}
                        className="h-full w-full object-cover"
                        fill
                        sizes="56px"
                        src={primaryImage.url}
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
                    <p className="text-sm font-semibold uppercase tracking-[0.05em]">
                      {line.productName}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-black/75">
                      {[line.color, line.size].filter(Boolean).join(" / ") || "Biến thể"} · SL {line.quantity}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-medium">
                    {currency.format((line.price ?? 0) * line.quantity)}
                  </p>
                </div>
              );
            })}
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-5">
              <dt className="text-black/75">Tạm tính</dt>
              <dd>{currency.format(totals.merchandiseSubtotalVnd)}</dd>
            </div>
            <div className="flex justify-between gap-5">
              <dt className="text-black/75">Phí vận chuyển</dt>
              <dd>{totals.shippingFeeVnd === 0 ? "Miễn phí" : currency.format(totals.shippingFeeVnd)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-5 border-t border-black pt-4">
              <dt className="font-semibold uppercase tracking-[0.08em]">Tổng dự kiến</dt>
              <dd className="text-xl font-semibold tracking-[-0.02em]">{currency.format(totals.totalVnd)}</dd>
            </div>
          </dl>

          <p className="mt-5 text-xs leading-5 text-black/75">
            Đây là số tiền dự kiến. Máy chủ sẽ kiểm tra lại giá, tồn kho và phí vận chuyển khi bạn đặt hàng.
          </p>
        </aside>
      </div>
    </div>
  );
}
