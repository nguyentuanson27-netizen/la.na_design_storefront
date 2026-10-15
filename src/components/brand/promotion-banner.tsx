import Link from "next/link";

import type { PromotionBannerItem, PromotionBannerView } from "@/routes/cart-promotion-model";

/**
 * The promotion banner shared by the cart drawer, the cart page and checkout.
 *
 * Markup only -- every word and number comes from the view model, which comes from the server quote.
 * Reached conditions get a filled check and the brand's deep green so they read as "done" at a
 * glance; the bar toward the next gift slot stays in the brand's chocolate. Nothing here is a
 * colour-only signal: each item carries its own title, and the bar has a value and a label.
 */

export type PromotionBannerProps = Readonly<{
  view: PromotionBannerView | null | undefined;
  /** `compact` for the drawer; `full` for the cart page and checkout. */
  variant?: "compact" | "full";
  /** Where a gift slot that still needs a choice is sent; omitted where the picker is already on screen. */
  giftHref?: string;
  /** The drawer closes itself when the shopper follows `giftHref`. */
  onNavigate?: () => void;
  className?: string;
}>;

function CheckIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
      <rect height="5" width="18" x="3" y="8" />
      <path d="M12 8v13M5 13v8h14v-8M7.5 8a2.5 2.5 0 010-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 010 5" />
    </svg>
  );
}

function Item({
  item,
  compact,
  giftHref,
  onNavigate,
}: Readonly<{ item: PromotionBannerItem; compact: boolean; giftHref?: string; onNavigate?: () => void }>) {
  const achieved = item.state === "achieved";
  return (
    <li className="flex gap-3" data-promotion-state={item.state} data-promotion-kind={item.kind}>
      <span
        aria-hidden="true"
        className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          achieved ? "bg-[#2F5D3A] text-white" : "border border-[#3B2219]/35 text-[#3B2219]"
        }`}
      >
        {achieved ? <CheckIcon /> : <GiftIcon />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`${compact ? "text-[0.8rem]" : "text-sm"} font-semibold leading-5 ${achieved ? "text-[#24472D]" : "text-[#2A1810]"}`}>
          {item.title}
        </p>
        <p className={`mt-0.5 ${compact ? "text-[0.72rem] leading-[1.15rem]" : "text-xs leading-5"} text-[#70584B]`}>{item.detail}</p>
        {item.progress ? (
          <div className="mt-2">
            <div
              aria-label={item.title}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={item.progress.percent}
              aria-valuetext={item.progress.label}
              className="h-1.5 w-full overflow-hidden rounded-full bg-[#3B2219]/12"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-[#3B2219] transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${item.progress.percent}%` }}
              />
            </div>
            <p className="mt-1 text-[0.7rem] uppercase tracking-[0.08em] text-[#70584B]">{item.progress.label}</p>
          </div>
        ) : null}
        {item.needsGiftChoice && giftHref ? (
          <Link
            className="mt-1.5 inline-block text-xs font-semibold uppercase tracking-[0.08em] text-[#2A1810] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
            href={giftHref}
            onClick={onNavigate}
          >
            Chọn quà
          </Link>
        ) : null}
      </div>
    </li>
  );
}

export function PromotionBanner({ view, variant = "full", giftHref, onNavigate, className = "" }: PromotionBannerProps) {
  if (!view || view.items.length === 0) return null;
  const compact = variant === "compact";
  const earned = view.items.some((item) => item.state === "achieved");
  return (
    <section
      aria-label="Ưu đãi của bạn"
      aria-live="polite"
      className={`border ${earned ? "border-[#2F5D3A]/35 bg-[#2F5D3A]/[0.06]" : "border-[#3B2219]/15 bg-[#F5F0E8]"} ${compact ? "rounded px-3 py-3" : "rounded px-4 py-4"} ${className}`}
      data-promotion-banner={variant}
    >
      <ul className={compact ? "space-y-3" : "space-y-4"}>
        {view.items.map((item) => (
          <Item compact={compact} giftHref={giftHref} item={item} key={item.id} onNavigate={onNavigate} />
        ))}
      </ul>
    </section>
  );
}
