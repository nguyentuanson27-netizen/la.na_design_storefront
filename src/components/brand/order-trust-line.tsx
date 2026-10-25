import { ORDER_TRUST_FACTS } from "@/brand";

/**
 * The reassurance line under every order button (cart drawer, cart page, checkout).
 *
 * The facts come from Brand Config, not from this markup: how the buyer pays, that they may inspect
 * before paying, and the return window are owner-approved policy, so a page cannot word them
 * differently from `/returns`. Each fact carries its own text; the tick is decoration only.
 */
export function OrderTrustLine({ className = "" }: Readonly<{ className?: string }>) {
  return (
    <ul
      aria-label="Cam kết khi đặt hàng"
      className={`flex flex-wrap justify-center gap-x-3 gap-y-1 text-[0.72rem] leading-5 text-[#70584B] ${className}`}
      data-order-trust
    >
      {ORDER_TRUST_FACTS.map((fact) => (
        <li className="inline-flex items-center gap-1" key={fact}>
          <svg aria-hidden="true" className="h-3 w-3 shrink-0 text-[#2F5D3A]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          {fact}
        </li>
      ))}
    </ul>
  );
}
