import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import { BrandCartLineControls } from "@/components/brand/cart-line-controls";
import { BrandPreorderFulfillmentNotice } from "@/components/brand/preorder-fulfillment-notice";
import { loadCartRoute, type CartRouteProps } from "@/routes/cart";
import type { CartLineView, CartViewModel } from "@/routes/cart-model";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCartMetadata } from "@/routes/metadata/cart";

/** Markup only. The lines, the subtotal and the `view_cart` event live in `@/routes/cart`. */

const breadcrumbLinkClassName =
  "hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black";

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
      <ol className="flex items-center gap-2">
        <li><Link className={breadcrumbLinkClassName} href="/">Trang chủ</Link></li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-black font-medium">Giỏ hàng</li>
      </ol>
    </nav>
  );
}

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
      <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
        <Breadcrumb />
        <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          GIỎ HÀNG
        </h1>
        <div className="mt-12 border-t border-black/20 pt-8" data-ui-state="empty">
          <p className="font-serif text-2xl md:text-3xl">Giỏ hàng của bạn đang trống.</p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Khám phá các thiết kế mới nhất trong bộ sưu tập của chúng tôi.
          </p>
          <Link className="text-link mt-6 inline-block" href="/shop">Tiếp tục mua sắm ↗</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <Breadcrumb />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <h1 className="text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          GIỎ HÀNG
        </h1>
        <p className="pb-2 text-xs uppercase tracking-[0.14em] text-black/70">
          {data.lineCount} sản phẩm
        </p>
      </div>
      <div className="mt-12 grid gap-12 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.34fr)] lg:gap-16">
        <div className="divide-y divide-black/15">
          {data.lines.map((line, index) => (
            <article
              className="grid gap-6 py-8 first:pt-0 sm:grid-cols-[9rem_minmax(0,1fr)] md:grid-cols-[11rem_minmax(0,1fr)]"
              key={line.variantId}
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
                        className="text-lg font-semibold uppercase tracking-[0.06em] underline decoration-transparent underline-offset-4 transition hover:decoration-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                        href={`/shop/${encodeURIComponent(line.productSlug)}`}
                      >
                        {line.productName}
                      </Link>
                    ) : (
                      <h2 className="text-lg font-semibold uppercase tracking-[0.06em]">{line.productName}</h2>
                    )}
                    <p className="mt-2 text-sm text-black/75">{line.optionLabel}</p>
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
                    <p className="font-medium">{line.priceText}</p>
                    <p className={`mt-1 text-xs uppercase tracking-[0.12em] ${line.available ? "text-black/70" : "font-semibold text-black"}`}>
                      {line.availabilityLabel}
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
        <aside className="h-fit border-t border-black pt-6 lg:sticky lg:top-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em]">Tóm tắt</p>
          <div className="mt-5 flex items-baseline justify-between gap-6 border-b border-black/15 pb-5">
            <span className="text-sm text-black/75">
              {data.hasUnavailableLines ? "Tạm tính khả dụng" : "Tạm tính"}
            </span>
            <strong className="text-xl font-medium tracking-[-0.02em]">{data.subtotalText}</strong>
          </div>
          {data.hasUnavailableLines ? (
            <p className="mt-4 text-sm leading-6 text-black/75">
              Sản phẩm không khả dụng không được tính vào tạm tính. Bạn có thể giảm số lượng khi tồn kho không đủ hoặc xóa dòng khỏi giỏ hàng.
            </p>
          ) : null}
          <p className="mt-4 text-sm leading-6 text-black/75">
            Giá và tồn kho hiện tại sẽ được kiểm tra lại trước khi tạo đơn. Phí vận chuyển chưa được cộng ở đây.
          </p>
          {data.preorderNotice === null ? null : (
            <BrandPreorderFulfillmentNotice
              notice={data.preorderNotice}
              titleId="preorder-fulfillment-title"
            />
          )}
          {data.canCheckout ? (
            <Link
              className="checkout-cta mt-7 block border border-black bg-black px-5 py-4 text-center text-sm font-semibold uppercase tracking-[0.14em] text-white underline decoration-transparent underline-offset-4 hover:bg-transparent hover:text-black hover:decoration-black transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              href="/checkout"
            >
              Tiến hành đặt hàng
            </Link>
          ) : (
            <p className="mt-6 border border-black/20 px-4 py-3 text-sm leading-6 text-black/75">
              Hãy xử lý các dòng chưa khả dụng trước khi thanh toán.
            </p>
          )}
          <Link className="text-link mt-7 inline-block" href="/shop">Tiếp tục mua sắm ↗</Link>
        </aside>
      </div>
    </div>
  );
}

const route = createStorefrontRoute<CartRouteProps, CartViewModel>({ load: loadCartRoute, render });

export const metadata = buildCartMetadata();
export default route.Page;
