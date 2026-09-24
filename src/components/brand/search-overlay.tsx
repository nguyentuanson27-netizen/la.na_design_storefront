"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BRAND } from "@/brand";
import { handleDrawerFocusTrap } from "@/components/headless/cart-drawer-model";
import { useScrollLock } from "@/components/headless/use-scroll-lock";
import { STOREFRONT_DISCOVERY_LIMITS } from "@/components/headless/search-overlay-model";
import { useSearchOverlay } from "@/components/headless/use-search-overlay";

export type SearchOverlayProps = Readonly<{
  isOpen: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}>;

export function SearchOverlay({ isOpen, onClose, triggerRef }: SearchOverlayProps) {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);

  const { query, setQuery, clearQuery, isLoading, result, announcement } =
    useSearchOverlay(isOpen);

  const wasOpenRef = useRef(false);

  // Focus management: save active element, auto-focus input, restore focus on close
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      previouslyFocusedElement.current =
        triggerRef?.current ?? (document.activeElement as HTMLElement | null);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const fallbackTarget = triggerRef?.current;
      const candidateTarget = previouslyFocusedElement.current ?? triggerRef?.current;
      const target =
        candidateTarget && document.body.contains(candidateTarget)
          ? candidateTarget
          : fallbackTarget;
      target?.focus?.();
    }
  }, [isOpen, triggerRef]);

  // Holds the page still behind the dialog; see the note in `useScrollLock` for why body alone
  // is not enough on this site.
  useScrollLock(isOpen);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        handleDrawerFocusTrap(event, overlayRef.current);
      }
    },
    [isOpen, onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length > 0 && trimmed.length <= STOREFRONT_DISCOVERY_LIMITS.query) {
      onClose();
      router.push(`/shop?q=${encodeURIComponent(trimmed)}`);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Tìm kiếm sản phẩm"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-[#FAF7F2] text-[#3B2219]"
    >
      {/* Live region for screen reader announcements */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Top Header Bar */}
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-6 py-6 md:py-8">
        <Link
          href="/"
          onClick={onClose}
          className="font-display text-xl font-bold tracking-wider text-[#2A1810]"
        >
          {BRAND.identity.displayNameUpper}
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng tìm kiếm"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#3B2219] hover:bg-[#3B2219]/10 transition-colors focus-visible:outline-2 focus-visible:outline-[#3B2219]"
        >
          <svg className="h-6 w-6 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Main Search Input Area */}
      <div className="mx-auto w-full max-w-[900px] px-6 py-6 md:py-10">
        <form onSubmit={handleSubmit} role="search" className="relative border-b-2 border-[#3B2219]">
          <div className="flex items-center">
            <svg
              className="mr-4 h-6 w-6 text-[#70584B] stroke-current"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16" y2="16" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              name="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={STOREFRONT_DISCOVERY_LIMITS.query}
              placeholder="Tìm kiếm sản phẩm..."
              aria-label="Nhập từ khóa tìm kiếm"
              className="w-full bg-transparent py-4 text-xl md:text-3xl font-display text-[#2A1810] outline-none placeholder:text-[#70584B]"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={clearQuery}
                aria-label="Xóa từ khóa"
                className="p-2 text-[#70584B] hover:text-[#2A1810]"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : null}
            {isLoading ? (
              <div className="ml-2 inline-flex h-5 w-5 animate-spin rounded-full border-2 border-[#3B2219] border-t-transparent" />
            ) : null}
          </div>
        </form>

        {/* Suggestions Results */}
        <div className="mt-10 space-y-10">
          {/* Category Suggestions */}
          {result.categories.length > 0 ? (
            <div>
              <p className="eyebrow text-[#70584B] mb-4">
                {query.trim().length > 0 ? "Danh mục phù hợp" : "Danh mục nổi bật"}
              </p>
              <div className="flex flex-wrap gap-2.5">
                {result.categories.map((category) => (
                  <Link
                    key={category.key}
                    href={category.href}
                    onClick={onClose}
                    className="font-display inline-flex items-center rounded-full border border-[#3B2219]/20 bg-white/60 px-4 py-2 text-xs font-medium text-[#3B2219] hover:border-[#3B2219] hover:bg-[#3B2219] hover:text-white transition-colors"
                  >
                    {category.label}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {/* Search Results / Error / Empty */}
          {result.error && !isLoading ? (
            <div role="alert" className="py-8 text-center">
              <p className="font-display text-lg text-[#8A3A35]">
                {result.error}
              </p>
              <p className="mt-2 text-xs text-[#70584B]">
                Vui lòng thử lại sau hoặc tìm kiếm với từ khóa khác.
              </p>
            </div>
          ) : result.products.length > 0 ? (
            <div>
              <p className="eyebrow text-[#70584B] mb-4">Sản phẩm gợi ý</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
                {result.products.map((product) => (
                  <Link
                    key={product.id}
                    href={`/shop/${encodeURIComponent(product.slug)}`}
                    onClick={onClose}
                    className="group flex flex-col gap-2"
                  >
                    <div className="relative aspect-[2/3] w-full overflow-hidden rounded bg-[#3B2219]/5">
                      {product.primaryImageUrl ? (
                        <Image
                          src={product.primaryImageUrl}
                          alt={product.name}
                          fill
                          sizes="(max-width: 640px) 50vw, 33vw"
                          className="object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-medium text-[#70584B]">
                          {BRAND.identity.displayNameUpper}
                        </div>
                      )}
                    </div>
                    <span className="font-display text-sm font-medium text-[#2A1810] group-hover:underline line-clamp-1">
                      {product.name}
                    </span>
                    {product.priceText ? (
                      <span className="font-sans text-xs font-semibold text-[#2A1810]">
                        {product.priceText}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            </div>
          ) : query.trim().length > 0 && !isLoading ? (
            <div className="py-8 text-center">
              <p className="font-display text-lg text-[#2A1810]">
                Không tìm thấy sản phẩm nào phù hợp với &ldquo;{query.trim()}&rdquo;
              </p>
              <p className="mt-2 text-xs text-[#70584B]">
                Vui lòng kiểm tra lại chính tả hoặc thử tìm kiếm với từ khóa khác.
              </p>
            </div>
          ) : null}

          {/* View All CTA */}
          {query.trim().length > 0 && query.trim().length <= STOREFRONT_DISCOVERY_LIMITS.query ? (
            <div className="border-t border-[#3B2219]/15 pt-6 text-center">
              <Link
                href={`/shop?q=${encodeURIComponent(query.trim())}`}
                onClick={onClose}
                className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em] text-[#2A1810] underline underline-offset-4"
              >
                Xem tất cả kết quả cho &ldquo;{query.trim()}&rdquo; →
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
