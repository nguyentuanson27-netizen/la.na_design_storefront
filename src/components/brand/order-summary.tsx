import type { OrderSummaryView } from "@/routes/order-summary-model";

/**
 * The bill, in reading order: order value, each discount, shipping, total. Markup only; every number comes
 * from `buildOrderSummary`. `compact` is the drawer; `page` is the cart and checkout.
 */
export function OrderSummary({
  summary,
  variant = "page",
  totalLabel = "Tổng thanh toán",
  className = "",
}: Readonly<{ summary: OrderSummaryView; variant?: "compact" | "page"; totalLabel?: string; className?: string }>) {
  const compact = variant === "compact";
  const row = compact ? "flex items-baseline justify-between gap-4 text-xs" : "flex items-baseline justify-between gap-5 text-sm";
  return (
    <dl className={`${compact ? "space-y-2" : "space-y-3"} ${className}`} data-order-summary={variant}>
      <div className={row}>
        <dt className={compact ? "text-[#70584B]" : "text-black/75"}>Tổng giá trị đơn hàng</dt>
        <dd className="shrink-0">{summary.valueText}</dd>
      </div>
      {summary.discounts.map((discount) => (
        <div className={`${row} font-medium text-[#24472D]`} data-promotion-savings key={discount.id}>
          <dt className="min-w-0">{discount.label}</dt>
          <dd className="shrink-0">{discount.amountText}</dd>
        </div>
      ))}
      {summary.giftQuantity > 0 ? (
        <div className={row}>
          <dt className={compact ? "text-[#70584B]" : "text-black/75"}>Quà tặng ({summary.giftQuantity})</dt>
          <dd className="shrink-0">0 ₫</dd>
        </div>
      ) : null}
      <div className={row}>
        <dt className={compact ? "text-[#70584B]" : "text-black/75"}>Vận chuyển</dt>
        <dd className="shrink-0">{summary.shippingText}</dd>
      </div>
      {summary.shippingVoucher ? (
        <div className={`${row} font-medium text-[#24472D]`} data-shipping-voucher>
          <dt className="min-w-0">{summary.shippingVoucher.label}</dt>
          <dd className="shrink-0">{summary.shippingVoucher.amountText}</dd>
        </div>
      ) : null}
      <div className={`flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-t ${compact ? "border-[#3B2219]/15 pt-3" : "border-black pt-4"}`}>
        <dt className={compact ? "text-xs font-semibold uppercase tracking-wider text-[#3B2219]" : "font-semibold uppercase tracking-[0.08em]"}>{totalLabel}</dt>
        <dd className={`ml-auto max-w-full text-right ${compact ? "text-base font-semibold text-[#2A1810]" : "text-xl font-semibold tracking-[-0.02em]"}`}>{summary.totalText}</dd>
      </div>
    </dl>
  );
}
