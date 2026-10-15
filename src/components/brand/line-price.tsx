/**
 * A line's price, with its per-product promotion on the line itself: the catalog price struck through
 * and the percentage off beside it. Without a promotion it is just the price. Shared by the drawer,
 * the cart page and checkout so the promotion reads the same on all three.
 */
export function LinePrice({
  priceText,
  originalPriceText,
  discountPercent,
  className = "",
}: Readonly<{ priceText: string; originalPriceText?: string; discountPercent?: number; className?: string }>) {
  if (!originalPriceText) return <span className={className}>{priceText}</span>;
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-1.5 ${className}`} data-line-discount>
      <s className="font-normal text-[#70584B]">
        <span className="sr-only">Giá gốc </span>
        {originalPriceText}
      </s>
      <span>
        <span className="sr-only">Giá khuyến mãi </span>
        {priceText}
      </span>
      {discountPercent ? (
        <span className="rounded-sm bg-[#2F5D3A]/10 px-1 py-px text-[0.65rem] font-semibold leading-4 text-[#24472D]">
          <span aria-hidden="true">−{discountPercent}%</span>
          <span className="sr-only">giảm {discountPercent}%</span>
        </span>
      ) : null}
    </span>
  );
}
