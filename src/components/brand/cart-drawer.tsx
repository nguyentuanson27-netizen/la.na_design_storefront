"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import {
  handleDrawerFocusTrap,
  isMeaningfulReturnFocusTarget,
} from "@/components/headless/cart-drawer-model";
import { useScrollLock } from "@/components/headless/use-scroll-lock";
import { useCartDrawer } from "@/components/headless/use-cart-drawer";

export type CartDrawerProps = Readonly<{
  isOpen: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}>;

export function CartDrawer({ isOpen, onClose, triggerRef }: CartDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);

  const { cart, isLoading, isPending, error, loadCart, updateQuantity, removeItem } =
    useCartDrawer(isOpen);

  const wasOpenRef = useRef(false);

  // Focus management: save active element on open, focus close button, restore focus on close
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      previouslyFocusedElement.current = document.activeElement as HTMLElement | null;
      // Focus after DOM render
      const timer = setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      /*
       * The saved element is only worth returning to while it is still a real, connected control.
       * Opened programmatically -- as the mobile purchase sheet does, after closing itself -- there
       * was nothing focused to save, so this falls back to the header's cart button rather than
       * leaving focus on the body.
       */
      const saved = previouslyFocusedElement.current;
      const returnFocusTarget = isMeaningfulReturnFocusTarget(saved) ? saved : triggerRef?.current;
      returnFocusTarget?.focus?.();
    }
  }, [isOpen, triggerRef]);

  // Holds the page still behind the drawer; see the note in `useScrollLock` for why body alone is
  // not enough on this site.
  useScrollLock(isOpen);

  // Keyboard navigation: Escape to close, Tab to trap focus
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        handleDrawerFocusTrap(event, drawerRef.current);
      }
    },
    [isOpen, onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-hidden" role="region" aria-label="Giỏ hàng">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Container */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Giỏ hàng"
        className="fixed inset-y-0 right-0 flex max-w-full pl-10"
      >
        <div className="flex w-screen max-w-md flex-col bg-[#FAF7F2] text-[#3B2219] shadow-2xl border-l border-[#3B2219]/15">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#3B2219]/10 px-6 py-5">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-xl font-bold tracking-tight text-[#2A1810]">
                Giỏ hàng
              </h2>
              {cart && !cart.isEmpty ? (
                <span className="text-xs uppercase tracking-wider text-[#70584B]">
                  ({cart.lineCount} sản phẩm)
                </span>
              ) : null}
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Đóng giỏ hàng"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[#3B2219] hover:bg-[#3B2219]/10 transition-colors focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-6" tabIndex={-1}>
            {isLoading && !cart ? (
              <div className="space-y-6 animate-pulse" aria-label="Đang tải giỏ hàng">
                {[1, 2].map((i) => (
                  <div key={i} className="flex gap-4">
                    <div className="h-24 w-20 rounded bg-[#3B2219]/10" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-4 w-3/4 rounded bg-[#3B2219]/10" />
                      <div className="h-3 w-1/2 rounded bg-[#3B2219]/10" />
                      <div className="h-4 w-1/4 rounded bg-[#3B2219]/10" />
                    </div>
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="py-12 text-center" role="alert">
                <p className="text-sm text-red-700">{error}</p>
                <button
                  type="button"
                  onClick={loadCart}
                  className="mt-4 inline-block text-xs font-semibold uppercase tracking-wider underline hover:text-[#2A1810]"
                >
                  Thử lại
                </button>
              </div>
            ) : cart?.isEmpty ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-[#3B2219]/5 text-[#3B2219]/60">
                  <svg className="h-8 w-8 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" aria-hidden="true">
                    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <path d="M16 10a4 4 0 0 1-8 0" />
                  </svg>
                </div>
                <h3 className="font-display text-lg font-medium text-[#2A1810]">
                  Giỏ hàng của bạn đang trống
                </h3>
                <p className="mt-2 max-w-xs text-xs text-[#70584B] leading-5">
                  Khám phá các thiết kế mới nhất trong bộ sưu tập của chúng tôi.
                </p>
                <Link
                  href="/shop"
                  onClick={onClose}
                  className="btn btn--outline mt-6"
                >
                  Tiếp tục mua sắm
                </Link>
              </div>
            ) : cart ? (
              <ul className="divide-y divide-[#3B2219]/10">
                {cart.lines.map((line) => (
                  <li key={line.variantId} className="flex gap-4 py-5 first:pt-0 last:pb-0">
                    {/* Visual */}
                    <div className="relative aspect-[3/4] w-20 flex-shrink-0 overflow-hidden rounded bg-[#3B2219]/5">
                      {line.primaryImage ? (
                        <Image
                          src={line.primaryImage.url}
                          alt={line.primaryImage.alt || line.productName}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[0.65rem] font-medium text-[#70584B]">
                          {BRAND.identity.displayNameUpper}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex flex-1 flex-col justify-between">
                      <div>
                        {line.productSlug ? (
                          <Link
                            href={`/shop/${encodeURIComponent(line.productSlug)}`}
                            onClick={onClose}
                            className="font-display text-sm font-medium text-[#2A1810] underline underline-offset-4"
                          >
                            {line.productName}
                          </Link>
                        ) : (
                          <span className="font-display text-sm font-medium text-[#2A1810]">
                            {line.productName}
                          </span>
                        )}
                        <p className="mt-0.5 text-xs text-[#70584B]">{line.optionLabel}</p>
                        <p className="mt-1 font-sans text-xs font-semibold text-[#2A1810]">
                          {line.priceText}
                        </p>
                        {!line.available ? (
                          <p className="mt-1 text-[0.7rem] font-medium text-amber-800">
                            {line.availabilityLabel}
                          </p>
                        ) : null}
                      </div>

                      {/* Quantity & Remove */}
                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center rounded border border-[#3B2219]/20 bg-white">
                          <button
                            type="button"
                            disabled={isPending || line.quantity <= 1}
                            onClick={() => updateQuantity(line.variantId, line.quantity - 1)}
                            aria-label={`Giảm số lượng ${line.productName}`}
                            className="inline-flex h-11 w-11 items-center justify-center text-base text-[#3B2219] hover:bg-[#3B2219]/10 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                          >
                            -
                          </button>
                          <span className="w-8 text-center text-xs font-medium text-[#2A1810]">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            disabled={isPending || !line.canUpdate}
                            onClick={() => updateQuantity(line.variantId, line.quantity + 1)}
                            aria-label={`Tăng số lượng ${line.productName}`}
                            className="inline-flex h-11 w-11 items-center justify-center text-base text-[#3B2219] hover:bg-[#3B2219]/10 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                          >
                            +
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => removeItem(line.variantId)}
                          aria-label={`Xóa ${line.productName} khỏi giỏ hàng`}
                          className="inline-flex min-h-11 items-center px-2 text-xs text-[#70584B] hover:text-red-700 hover:underline transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Xóa
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* Footer */}
          {cart && !cart.isEmpty ? (
            <div className="border-t border-[#3B2219]/10 bg-[#FAF7F2] p-6 space-y-4">
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wider text-[#70584B]">Tạm tính</span>
                <span className="font-sans text-base font-semibold text-[#2A1810]">
                  {cart.subtotalText}
                </span>
              </div>
              <p className="text-[0.72rem] text-[#70584B] leading-relaxed">
                Phí vận chuyển và ưu đãi sẽ được tính toán tại bước thanh toán.
              </p>

              <div className="space-y-2 pt-2">
                {cart.canCheckout ? (
                  <Link
                    href="/checkout"
                    onClick={onClose}
                    className="btn btn--primary w-full"
                  >
                    Tiến hành đặt hàng
                  </Link>
                ) : (
                  <p className="text-center text-xs text-amber-800">
                    Vui lòng điều chỉnh các sản phẩm không khả dụng trước khi đặt hàng.
                  </p>
                )}

                <Link
                  href="/cart"
                  onClick={onClose}
                  className="btn btn--outline w-full"
                >
                  Xem chi tiết giỏ hàng
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
