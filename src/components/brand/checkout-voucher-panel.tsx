"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";

import { useVoucherHold } from "@/components/headless/use-voucher-hold";
import type { CheckoutVoucherLine, CheckoutVoucherView } from "@/routes/checkout-model";
import { VoucherIcon } from "./voucher-icons";

/**
 * Voucher v1 (V18): the vouchers' part of the checkout. It decides and prices nothing: a held voucher is already in the
 * quote beside it, an offer is previewed by the server, and "Áp dụng" is one deliberate POST that holds it for ten
 * minutes. Every word below the voucher lines comes from the server's answer, never from what the browser expected.
 *
 * It wears the same ticket language as the cart and the picker (type colours, names, the held ticket), and "change" opens the SAME picker in place
 * (`change`, built by the page) instead of sending the shopper back to the cart. Changing the choice makes the old holds stale, so the panel
 * then asks to confirm the new offer, as it always did after a cart change.
 */

/** One voucher line: a colour square (its type's colour, neutral when unknown), its name, what it takes off. */
function VoucherLine({ line, emphasis }: Readonly<{ line: CheckoutVoucherLine; emphasis: boolean }>) {
  return (
    <li className={`voucher-tone ${line.tone ? `voucher-tone--${line.tone}` : ""} flex items-center justify-between gap-4`} data-checkout-voucher-line>
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="voucher-held__mi"><VoucherIcon name={line.kind === "SHIPPING_FREE" ? "truck" : "tag"} className="h-4 w-4" /></span>
        <span className="grid min-w-0 leading-snug">
          {line.title}
          {line.group ? <small className="text-xs text-black/60">{line.group}</small> : null}
        </span>
      </span>
      <span className={`shrink-0 font-semibold ${emphasis ? "text-[#9a3324]" : "text-black/75"}`}>{line.amountText}</span>
    </li>
  );
}

/**
 * Keeps keyboard and screen-reader users in the vouchers' place when the page re-renders it. Changing vouchers refreshes the page:
 * the panel switches state (held, offered, stale, or back to the entry ticket) and the picker remounts, so the control that had focus
 * is gone and focus would fall to the page body. When -- and only when -- focus was lost that way, it moves to what the vouchers now
 * say (the panel's heading, or the entry ticket). A refresh that does not change the vouchers, or focus that is elsewhere (an address
 * field), is never touched.
 */
export function CheckoutVoucherFocus({ stateKey, children }: Readonly<{ stateKey: string; children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(stateKey);
  useEffect(() => {
    if (last.current === stateKey) return;
    last.current = stateKey;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    ref.current?.querySelector<HTMLElement>("[data-voucher-focus], .voucher-entry")?.focus();
  }, [stateKey]);
  return <div ref={ref}>{children}</div>;
}

const HOLD_ERROR: Readonly<Record<string, string>> = {
  QUOTE_CHANGED: "Giá hoặc ưu đãi vừa thay đổi. Nàng xem lại số tiền bên dưới rồi xác nhận lại nhé.",
  CONFIRMATION_REQUIRED: "Nàng tích ô xác nhận phía trên để tiếp tục.",
  CAPACITY_EXHAUSTED: "Voucher vừa hết lượt. Nàng xem lại ưu đãi nhé.",
  CAMPAIGN_NOT_ACTIVE: "Voucher không còn áp dụng. Nàng xem lại ưu đãi nhé.",
  CAMPAIGN_CHANGED: "Voucher vừa được cập nhật. Nàng xem lại ưu đãi nhé.",
  CART_CHANGED: "Giỏ hàng vừa thay đổi. Nàng xem lại ưu đãi nhé.",
  RATE_LIMITED: "Nàng thao tác hơi nhanh. Vui lòng thử lại sau ít phút.",
  PREVIEW_ONLY: "Ưu đãi chưa thể giữ lúc này. Nàng có thể đặt hàng không dùng ưu đãi bằng cách bỏ chọn voucher trong giỏ hàng.",
  FEATURE_DISABLED: "Ưu đãi tạm thời chưa khả dụng.",
  SHOP_NOT_VERIFIED: "Ưu đãi chưa thể giữ lúc này.",
  POS_INFEASIBLE: "Ưu đãi này chưa thể áp dụng cho đơn hàng hiện tại.",
  PROOF_UNAVAILABLE: "Giỏ hàng có quá nhiều dòng nên chưa giữ được ưu đãi. Nàng bớt vài sản phẩm rồi thử lại nhé.",
};
const GENERIC_ERROR = "Chưa giữ được ưu đãi. Nàng thử lại sau giây lát nhé.";

function minutesLeft(untilMs: number | null): number | null {
  return untilMs === null ? null : Math.ceil((untilMs - Date.now()) / 60_000);
}

export function CheckoutVoucherPanel({ view, change = null }: Readonly<{
  view: CheckoutVoucherView;
  /** The picker's "change" control, placed by the page. Null falls back to the link that sends the shopper to the cart. */
  change?: ReactNode;
}>) {
  const router = useRouter();
  const { hold } = useVoucherHold();
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Time is read after mount only, so the server render and the first client render agree.
  const [left, setLeft] = useState<number | null>(null);
  const heldUntilMs = view.state === "HELD" ? view.heldUntilMs : null;
  // The pill counts the seconds ("09:42"); the sentence below keeps the minutes. Both read the clock after mount only.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const consentId = useId();

  useEffect(() => {
    if (heldUntilMs === null) return;
    const tick = () => {
      const minutes = minutesLeft(heldUntilMs);
      setLeft(minutes);
      // At the expiry the server stops applying the hold; asking it again re-prices the page honestly.
      if (minutes !== null && minutes <= 0) router.refresh();
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [heldUntilMs, router]);

  useEffect(() => {
    if (heldUntilMs === null) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((heldUntilMs - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [heldUntilMs]);

  if (view.state === "HELD") {
    return (
      <section aria-label="Ưu đãi" className="voucher-held text-sm" data-checkout-vouchers="held">
        <div className="voucher-held__head">
          <span className="voucher-held__ok"><VoucherIcon name="check" /></span>
          <p className="font-semibold outline-none" data-voucher-focus tabIndex={-1}>Ưu đãi đang áp dụng cho đơn này</p>
          {secondsLeft !== null && secondsLeft > 0 ? (
            <span aria-hidden="true" className="voucher-held__pill">
              <VoucherIcon name="clock" className="h-3.5 w-3.5" />
              {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:{String(secondsLeft % 60).padStart(2, "0")}
            </span>
          ) : null}
        </div>
        <ul className="grid gap-2.5 px-3.5 py-3">
          {view.lines.map((line) => <VoucherLine emphasis key={line.id} line={line} />)}
        </ul>
        <div className="px-3.5 pb-3">
          {view.savingText ? <p className="mb-1" data-checkout-voucher-saving>Tổng giảm <strong className="text-[#9a3324]">{view.savingText}</strong></p> : null}
          <p className="text-black/75" data-checkout-voucher-held-until>
            {left === null ? "Ưu đãi được giữ tối đa 10 phút." : left > 0 ? `Ưu đãi được giữ thêm khoảng ${left} phút.` : "Ưu đãi đã hết hạn, đang cập nhật giá…"}
          </p>
          {change ?? <Link className="mt-1 inline-block min-h-11 content-center underline" href="/cart">Đổi ưu đãi ở giỏ hàng</Link>}
        </div>
      </section>
    );
  }

  if (view.state === "STALE") {
    return (
      <section aria-label="Ưu đãi" className="voucher-held px-3.5 py-3 text-sm" data-checkout-vouchers="stale">
        <p className="outline-none" data-voucher-focus role="status" tabIndex={-1}>Ưu đãi giữ trước đó không còn khớp với lựa chọn hoặc giỏ hàng hiện tại, nên giá bên dưới chưa có ưu đãi.</p>
        {change ?? <Link className="mt-1 inline-block min-h-11 content-center underline" href="/cart">Xem lại ở giỏ hàng</Link>}
      </section>
    );
  }

  const needsConsent = view.giftLossText !== null || view.totalIncreaseText !== null;
  const confirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await hold({ expectedQuoteDigest: view.digest, acknowledged: accepted });
        if (result.ok) {
          setAccepted(false);
          router.refresh();
          return;
        }
        setError(HOLD_ERROR[result.reason] ?? GENERIC_ERROR);
        // Whatever the reason, the page the shopper is reading may no longer be the server's truth.
        if (result.reason !== "CONFIRMATION_REQUIRED" && result.reason !== "RATE_LIMITED") router.refresh();
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  };

  return (
    <section aria-label="Ưu đãi" className="voucher-held text-sm" data-checkout-vouchers="offered">
      <div className="voucher-held__head">
        <span className="voucher-held__ok voucher-held__ok--offer"><VoucherIcon name="tag" /></span>
        <p className="font-semibold outline-none" data-voucher-focus tabIndex={-1}>{view.afterStale ? "Nàng xác nhận lại ưu đãi" : "Nàng có ưu đãi cho đơn này"}</p>
      </div>
      {view.afterStale ? <p className="px-3.5 pt-3 text-black/75">Ưu đãi giữ trước đó không còn khớp với lựa chọn hoặc giỏ hàng hiện tại.</p> : null}
      <ul className="grid gap-2.5 px-3.5 py-3">
        {view.lines.map((line) => <VoucherLine emphasis={false} key={line.id} line={line} />)}
      </ul>
      <div className="px-3.5 pb-3.5">
        <p data-checkout-voucher-total>Tổng sau ưu đãi (dự kiến): <strong>{view.totalText}</strong></p>
        {needsConsent ? (
          <div className="mt-3 border-t border-black/15 pt-3">
            {view.giftLossText ? <p data-checkout-voucher-gift-loss>{view.giftLossText}</p> : null}
            {view.totalIncreaseText ? <p className="mt-1" data-checkout-voucher-increase>{view.totalIncreaseText}</p> : null}
            <label className="mt-2 flex min-h-11 items-start gap-3" htmlFor={consentId}>
              <input checked={accepted} className="mt-1 h-5 w-5" id={consentId} onChange={(event) => setAccepted(event.currentTarget.checked)} type="checkbox" />
              <span>Tôi đồng ý với thay đổi trên và muốn dùng ưu đãi.</span>
            </label>
          </div>
        ) : null}
        <p className="mt-2 text-black/75">Ưu đãi được giữ 10 phút kể từ lúc nàng xác nhận.</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4">
          <button className="btn btn--primary px-5" data-checkout-voucher-confirm disabled={pending || (needsConsent && !accepted)} onClick={confirm} type="button">
            {pending ? "Đang giữ ưu đãi…" : "Áp dụng và giữ ưu đãi"}
          </button>
          {change ?? <Link className="min-h-11 content-center underline" href="/cart">Đổi hoặc bỏ ưu đãi</Link>}
        </div>
        <p aria-live="polite" className="mt-2 text-[#b42318] empty:hidden" data-checkout-voucher-error role="alert">{error}</p>
      </div>
    </section>
  );
}
