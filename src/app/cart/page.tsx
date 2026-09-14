import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";

import { BRAND } from "@/brand";
import { getCurrentStorefrontCartLines } from "@/commerce/storefront-cart-runtime";
import type { StorefrontCartLine } from "@/commerce/storefront-cart";
import { buildCartViewEvent } from "@/components/analytics/cart-funnel-tracking";
import {
  CommerceEventReporter,
  isCommerceTrackingEnabled,
} from "@/components/analytics/commerce-event-reporter";
import { CartLineControls } from "@/components/commerce/cart-line-controls";

export const metadata: Metadata = {
  title: "Giỏ hàng",
  description: `Giỏ hàng mua sắm tại ${BRAND.identity.name}.`,
};

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function unavailableLabel(line: StorefrontCartLine): string {
  switch (line.unavailableReason) {
    case "OUT_OF_STOCK":
      return "Tạm hết hàng";
    case "INSUFFICIENT_STOCK":
      return "Không đủ tồn kho cho số lượng này";
    case "PRICE_UNRESOLVED":
      return "Giá đang cập nhật";
    case "MAPPING_REQUIRED":
      return "Màu × kích cỡ chưa hoàn tất";
    case "AMBIGUOUS_OPTION":
      return "Màu × kích cỡ đang bị trùng";
    case "PRODUCT_UNAVAILABLE":
    case "VARIANT_UNAVAILABLE":
      return "Sản phẩm không còn khả dụng";
    default:
      return "Chưa thể mua online";
  }
}

function currentSubtotal(lines: readonly StorefrontCartLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    if (!line.available || line.price === null) continue;
    const lineTotal = line.price * line.quantity;
    if (!Number.isFinite(lineTotal)) return null;
    total += lineTotal;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

export default async function CartPage() {
  await connection();
  const lines = await getCurrentStorefrontCartLines();

  if (lines.length === 0) {
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
            <li aria-current="page" className="text-black font-medium">
              Giỏ hàng
            </li>
          </ol>
        </nav>
        <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          GIỎ HÀNG
        </h1>
        <div className="mt-12 border-t border-black/20 pt-8" data-ui-state="empty">
          <p className="font-serif text-2xl md:text-3xl">Giỏ hàng của bạn đang trống.</p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Khám phá các thiết kế mới nhất trong bộ sưu tập của chúng tôi.
          </p>
          <Link className="text-link mt-6 inline-block" href="/shop">
            Tiếp tục mua sắm ↗
          </Link>
        </div>
      </div>
    );
  }

  const subtotal = currentSubtotal(lines);
  const hasUnavailableLines = lines.some((line) => !line.available);
  const viewCartEvent = buildCartViewEvent(lines);
  const commerceTrackingEnabled = isCommerceTrackingEnabled();

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <CommerceEventReporter event={viewCartEvent} />
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
          <li aria-current="page" className="text-black font-medium">
            Giỏ hàng
          </li>
        </ol>
      </nav>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <h1 className="text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          GIỎ HÀNG
        </h1>
        <p className="pb-2 text-xs uppercase tracking-[0.14em] text-black/70">
          {lines.length} {lines.length === 1 ? "sản phẩm" : "sản phẩm"}
        </p>
      </div>

      <div className="mt-12 grid gap-12 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.34fr)] lg:gap-16">
        <div className="divide-y divide-black/15">
          {lines.map((line, index) => {
            const productName = line.productName ?? "Sản phẩm không còn trong catalog";
            const canUpdate =
              line.available || line.unavailableReason === "INSUFFICIENT_STOCK";
            const primaryImage = line.media.primary;

            const visual = (
              <div className="relative aspect-[3/4] w-full overflow-hidden bg-black/[0.04]">
                {primaryImage ? (
                  <Image
                    alt={primaryImage.alt}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    fill
                    priority={index === 0}
                    sizes="(max-width: 640px) 144px, 176px"
                    src={primaryImage.url}
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

            return (
              <article
                className="grid gap-6 py-8 first:pt-0 sm:grid-cols-[9rem_minmax(0,1fr)] md:grid-cols-[11rem_minmax(0,1fr)]"
                key={line.variantId}
              >
                <div>
                  {line.productSlug ? (
                    <Link
                      className="group block overflow-hidden border border-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                      href={`/shop/${encodeURIComponent(line.productSlug)}`}
                      aria-label={`Xem ${productName}`}
                    >
                      {visual}
                    </Link>
                  ) : (
                    <div className="overflow-hidden border border-black/10">
                      {visual}
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
                          {productName}
                        </Link>
                      ) : (
                        <h2 className="text-lg font-semibold uppercase tracking-[0.06em]">
                          {productName}
                        </h2>
                      )}
                      <p className="mt-2 text-sm text-black/75">
                        {[line.color, line.size].filter(Boolean).join(" / ") || "Màu / Kích cỡ không khả dụng"}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="font-medium">
                        {line.price === null ? "Giá đang cập nhật" : currency.format(line.price)}
                      </p>
                      <p
                        className={`mt-1 text-xs uppercase tracking-[0.12em] ${
                          line.available ? "text-black/70" : "font-semibold text-black"
                        }`}
                      >
                        {line.available ? "Có thể mua" : unavailableLabel(line)}
                      </p>
                    </div>
                  </div>

                  <CartLineControls
                    variantId={line.variantId}
                    initialQuantity={line.quantity}
                    canUpdate={canUpdate}
                    commerceTrackingEnabled={commerceTrackingEnabled}
                  />
                </div>
              </article>
            );
          })}
        </div>

        <aside className="h-fit border-t border-black pt-6 lg:sticky lg:top-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em]">Tóm tắt</p>
          <div className="mt-5 flex items-baseline justify-between gap-6 border-b border-black/15 pb-5">
            <span className="text-sm text-black/75">
              {hasUnavailableLines ? "Tạm tính khả dụng" : "Tạm tính"}
            </span>
            <strong className="text-xl font-medium tracking-[-0.02em]">
              {subtotal === null ? "Chưa thể tính" : currency.format(subtotal)}
            </strong>
          </div>
          {hasUnavailableLines ? (
            <p className="mt-4 text-sm leading-6 text-black/75">
              Sản phẩm không khả dụng không được tính vào tạm tính. Bạn có thể giảm số lượng khi tồn kho không đủ hoặc xóa dòng khỏi giỏ hàng.
            </p>
          ) : null}
          <p className="mt-4 text-sm leading-6 text-black/75">
            Giá và tồn kho hiện tại sẽ được kiểm tra lại trước khi tạo đơn. Phí vận chuyển chưa được cộng ở đây.
          </p>
          {!hasUnavailableLines && subtotal !== null ? (
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
          <Link className="text-link mt-7 inline-block" href="/shop">
            Tiếp tục mua sắm ↗
          </Link>
        </aside>
      </div>
    </div>
  );
}
