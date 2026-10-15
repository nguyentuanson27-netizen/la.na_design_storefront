import Link from "next/link";

import type { PromotionBannerItem, PromotionBannerView } from "@/routes/cart-promotion-model";

/**
 * The promotion lines shared by the cart drawer, the cart page and checkout.
 *
 * Deliberately quiet: no card, no tinted fill, one line per item. A reached condition gets a small
 * green tick, the way a receipt marks a done thing; the way to the next gift slot is a hairline bar
 * under one short sentence. The amount saved is not repeated here -- it sits beside the subtotal.
 * Every word and number comes from the view model, which comes from the server quote, and nothing is
 * a colour-only signal: each line carries its own text, and the bar has a value.
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

function Tick() {
  return (
    <span aria-hidden="true" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#2F5D3A] text-white">
      <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" viewBox="0 0 24 24">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

function Gift() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-[#70584B]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <rect height="5" width="18" x="3" y="8" />
      <path d="M12 8v13M5 13v8h14v-8M7.5 8a2.5 2.5 0 010-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 010 5" />
    </svg>
  );
}

function Item({
  item,
  giftHref,
  onNavigate,
}: Readonly<{ item: PromotionBannerItem; giftHref?: string; onNavigate?: () => void }>) {
  const achieved = item.state === "achieved";
  return (
    <li data-promotion-state={item.state} data-promotion-kind={item.kind}>
      <div className="flex items-center gap-2">
        {achieved ? <Tick /> : <Gift />}
        <p className={`min-w-0 flex-1 text-[0.8rem] leading-5 ${achieved ? "text-[#24472D]" : "text-[#3B2219]"}`}>{item.title}</p>
        {item.needsGiftChoice && giftHref ? (
          <Link
            className="shrink-0 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-[#2A1810] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
            href={giftHref}
            onClick={onNavigate}
          >
            Chọn quà
          </Link>
        ) : null}
      </div>
      {item.progress ? (
        <div
          aria-label={item.title}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={item.progress.percent}
          aria-valuetext={item.progress.label}
          className="ml-6 mt-1.5 h-[3px] overflow-hidden rounded-full bg-[#3B2219]/10"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-[#3B2219]/70 transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${item.progress.percent}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}

export function PromotionBanner({ view, variant = "full", giftHref, onNavigate, className = "" }: PromotionBannerProps) {
  if (!view || view.items.length === 0) return null;
  return (
    <section
      aria-label="Ưu đãi của bạn"
      aria-live="polite"
      className={`border-y border-[#3B2219]/10 py-3 ${variant === "full" ? "max-w-xl" : ""} ${className}`}
      data-promotion-banner={variant}
    >
      <ul className="space-y-2.5">
        {view.items.map((item) => (
          <Item giftHref={giftHref} item={item} key={item.id} onNavigate={onNavigate} />
        ))}
      </ul>
    </section>
  );
}
