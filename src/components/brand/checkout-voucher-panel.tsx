"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";

import { useVoucherHold } from "@/components/headless/use-voucher-hold";
import type { CheckoutVoucherView } from "@/routes/checkout-model";

/**
 * Voucher v1 (V18): the vouchers' part of the checkout. It decides and prices nothing: a held voucher is already in the
 * quote beside it, an offer is previewed by the server, and "Áp dụng" is one deliberate POST that holds it for ten
 * minutes. Every word below the voucher lines comes from the server's answer, never from what the browser expected.
 */

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

export function CheckoutVoucherPanel({ view }: Readonly<{ view: CheckoutVoucherView }>) {
  const router = useRouter();
  const { hold } = useVoucherHold();
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Time is read after mount only, so the server render and the first client render agree.
  const [left, setLeft] = useState<number | null>(null);
  const heldUntilMs = view.state === "HELD" ? view.heldUntilMs : null;
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

  if (view.state === "HELD") {
    return (
      <section aria-label="Ưu đãi" className="border border-black/20 px-4 py-4 text-sm" data-checkout-vouchers="held">
        <p className="font-semibold">Ưu đãi đang áp dụng cho đơn này</p>
        <ul className="mt-2 space-y-1">
          {view.lines.map((line) => (
            <li className="flex justify-between gap-4" data-checkout-voucher-line key={line.id}>
              <span className="min-w-0">{line.title}</span>
              <span className="shrink-0 font-medium text-[#24472D]">{line.amountText}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-black/75" data-checkout-voucher-held-until>
          {left === null ? "Ưu đãi được giữ tối đa 10 phút." : left > 0 ? `Ưu đãi được giữ thêm khoảng ${left} phút.` : "Ưu đãi đã hết hạn, đang cập nhật giá…"}
        </p>
        <Link className="mt-1 inline-block min-h-11 content-center underline" href="/cart">Đổi ưu đãi ở giỏ hàng</Link>
      </section>
    );
  }

  if (view.state === "STALE") {
    return (
      <p className="border border-black/20 px-4 py-3 text-sm" data-checkout-vouchers="stale" role="status">
        Ưu đãi nàng đã chọn đã hết hạn hoặc giỏ hàng đã thay đổi, nên giá bên dưới chưa có ưu đãi. <Link className="underline" href="/cart">Xem lại ở giỏ hàng</Link>.
      </p>
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
    <section aria-label="Ưu đãi" className="border border-black px-4 py-4 text-sm" data-checkout-vouchers="offered">
      <p className="font-semibold">{view.afterStale ? "Nàng xác nhận lại ưu đãi" : "Nàng có ưu đãi cho đơn này"}</p>
      {view.afterStale ? <p className="mt-1 text-black/75">Ưu đãi trước đó đã hết hạn hoặc giỏ hàng đã thay đổi.</p> : null}
      <ul className="mt-2 space-y-1">
        {view.lines.map((line) => (
          <li className="flex justify-between gap-4" data-checkout-voucher-line key={line.id}>
            <span className="min-w-0">{line.title}</span>
            <span className="shrink-0 text-black/75">{line.amountText}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2" data-checkout-voucher-total>Tổng sau ưu đãi (dự kiến): <strong>{view.totalText}</strong></p>
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
        <Link className="min-h-11 content-center underline" href="/cart">Đổi hoặc bỏ ưu đãi</Link>
      </div>
      <p aria-live="polite" className="mt-2 text-[#b42318] empty:hidden" data-checkout-voucher-error role="alert">{error}</p>
    </section>
  );
}
