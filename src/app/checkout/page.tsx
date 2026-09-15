import Image from "next/image";
import Link from "next/link";

import { BrandGuestCheckoutForm } from "@/components/brand/guest-checkout-form";
import { createStorefrontRoute } from "@/routes/factory";
import { loadCheckoutRoute, type CheckoutRouteProps } from "@/routes/checkout";
import type { CheckoutViewModel } from "@/routes/checkout-model";
import { buildCheckoutMetadata } from "@/routes/metadata/checkout";

/** Checkout's markup. Every decision behind it is in `@/routes/checkout` and its model. */

const BREADCRUMB_LINK =
  "hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black";

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
      <ol className="flex items-center gap-2">
        <li>
          <Link className={BREADCRUMB_LINK} href="/">
            Trang chủ
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>
          <Link className={BREADCRUMB_LINK} href="/cart">
            Giỏ hàng
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-black font-medium">
          Thanh toán
        </li>
      </ol>
    </nav>
  );
}

function render(data: CheckoutViewModel) {
  if (data.state !== "ready" || !data.totals || data.quoteProof === null) {
    return (
      <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
        <Breadcrumb />
        <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          THANH TOÁN
        </h1>
        {data.state === "empty" ? (
          <div className="mt-12 border-t border-black/20 pt-8" data-ui-state="empty">
            <p className="font-serif text-2xl md:text-3xl">Giỏ hàng của bạn đang trống.</p>
            <Link className="text-link mt-6 inline-block" href="/shop">
              Tiếp tục mua sắm ↗
            </Link>
          </div>
        ) : (
          <div className="mt-12 max-w-2xl border-t border-black/20 pt-8" data-ui-state="empty">
            <p className="font-serif text-2xl md:text-3xl">Giỏ hàng cần được kiểm tra lại.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Có sản phẩm, giá hoặc tồn kho chưa sẵn sàng để đặt hàng. Hãy quay lại giỏ hàng để cập nhật trước khi tiếp tục.
            </p>
            <Link className="text-link mt-6 inline-block" href="/cart">
              Quay lại giỏ hàng ↗
            </Link>
          </div>
        )}
      </div>
    );
  }

  const { lines, totals, quoteProof } = data;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <Breadcrumb />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <h1 className="text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          THANH TOÁN
        </h1>
        <p className="pb-2 text-xs uppercase tracking-[0.14em] text-black/70">Thanh toán khi nhận hàng</p>
      </div>

      <div className="mt-12 grid gap-12 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)] lg:gap-16">
        <BrandGuestCheckoutForm quoteProof={quoteProof} />

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
            {lines.map((line) => (
              <div className="flex items-start gap-4 py-4 first:pt-0" key={line.variantId}>
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
                  </p>
                </div>
                <p className="shrink-0 text-sm font-medium">{line.lineTotalText}</p>
              </div>
            ))}
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-5">
              <dt className="text-black/75">Tạm tính</dt>
              <dd>{totals.subtotalText}</dd>
            </div>
            <div className="flex justify-between gap-5">
              <dt className="text-black/75">Phí vận chuyển</dt>
              <dd>{totals.shippingText}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-5 border-t border-black pt-4">
              <dt className="font-semibold uppercase tracking-[0.08em]">Tổng dự kiến</dt>
              <dd className="text-xl font-semibold tracking-[-0.02em]">{totals.totalText}</dd>
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

const route = createStorefrontRoute<CheckoutRouteProps, CheckoutViewModel>({
  load: loadCheckoutRoute,
  render,
});

export const metadata = buildCheckoutMetadata();
export default route.Page;
