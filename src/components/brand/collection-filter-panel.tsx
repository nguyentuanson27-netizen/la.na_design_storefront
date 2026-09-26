"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { handleDrawerFocusTrap } from "../headless/cart-drawer-model";
import { useScrollLock } from "../headless/use-scroll-lock";
import { ListingResultCount } from "./listing-chrome";
import type { CollectionSizeOption, CollectionSortOption } from "../../routes/collection-model";

export type CollectionFilterPanelProps = {
  totalCount: number;
  sortOptions: readonly CollectionSortOption[];
  sizeOptions: readonly CollectionSizeOption[];
  clearFilterHref: string;
  filtered: boolean;
};

export function CollectionFilterPanel({
  totalCount,
  sortOptions,
  sizeOptions,
  clearFilterHref,
  filtered,
}: CollectionFilterPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const drawerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerButtonRef = useRef<HTMLElement | null>(null);
  const wasMobileOpenRef = useRef(false);

  useScrollLock(isMobileOpen);

  useEffect(() => {
    if (isMobileOpen) {
      wasMobileOpenRef.current = true;
      if (!openerButtonRef.current) {
        openerButtonRef.current = document.activeElement as HTMLElement | null;
      }
      const timer = setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (wasMobileOpenRef.current) {
      wasMobileOpenRef.current = false;
      openerButtonRef.current?.focus?.();
    }
  }, [isMobileOpen]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isMobileOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setIsMobileOpen(false);
      } else if (e.key === "Tab") {
        handleDrawerFocusTrap(e, drawerRef.current);
      }
    },
    [isMobileOpen],
  );

  useEffect(() => {
    if (!isMobileOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobileOpen, handleKeyDown]);

  const activeSort = sortOptions.find((opt) => opt.active) ?? sortOptions[0];
  const activeSortHref = activeSort?.href ?? "";

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextHref = e.target.value;
    startTransition(() => {
      router.push(nextHref, { scroll: false });
    });
  };

  const concreteSizes = sizeOptions.filter((opt) => opt.value !== null);
  const activeSizeOption = sizeOptions.find((opt) => opt.value !== null && opt.active);

  return (
    <div className="border-b border-[#3B2219]/15 pb-4">
      {/* Top action row: Count, mobile drawer button, desktop/mobile sort dropdown */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ListingResultCount>{totalCount} sản phẩm</ListingResultCount>

        <div className="flex items-center gap-3">
          {/* Mobile Filter Button */}
          <button
            type="button"
            onClick={(e) => {
              openerButtonRef.current = e.currentTarget;
              setIsMobileOpen(true);
            }}
            aria-expanded={isMobileOpen}
            aria-controls="mobile-collection-filters"
            className="btn btn--outline shrink-0 whitespace-nowrap px-4 md:hidden"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
              />
            </svg>
            <span>Bộ lọc</span>
            {filtered ? (
              <span className="flex h-1.5 w-1.5 rounded-full bg-[#3B2219]" aria-hidden="true" />
            ) : null}
          </button>
          <span aria-hidden="true" className="text-xs text-[#70584B] md:hidden">
            ·
          </span>

          {/* Sort Selector */}
          <nav aria-label="Sắp xếp bộ sưu tập" className="flex items-center gap-2">
            <label
              htmlFor="collection-sort-select"
              className="text-xs uppercase tracking-wider text-[#3B2219]/70"
            >
              Sắp xếp:
            </label>
            <select
              id="collection-sort-select"
              aria-label="Sắp xếp sản phẩm"
              value={activeSortHref}
              onChange={handleSortChange}
              className="rounded border border-[#3B2219]/20 bg-transparent px-3 py-1.5 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              {sortOptions.map((opt) => (
                <option key={opt.value} value={opt.href}>
                  {opt.label}
                </option>
              ))}
            </select>
          </nav>
        </div>
      </div>

      {/* Desktop Filter Bar */}
      <nav
        aria-label="Lọc theo kích cỡ"
        className="mt-4 hidden md:flex md:flex-wrap md:items-center md:gap-x-6 md:gap-y-3 text-xs text-[#3B2219]"
      >
        {concreteSizes.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[#70584B] mr-1">
              Size:
            </span>
            {concreteSizes.map((opt) => (
              <Link
                key={opt.value}
                href={opt.href}
                scroll={false}
                aria-current={opt.active ? "true" : undefined}
                className={`min-w-7 text-center rounded-md border px-2 py-1 font-medium uppercase transition ${
                  opt.active
                    ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                    : "border-[#3B2219]/20 hover:border-[#3B2219]"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        ) : null}

        {/* Clear filter link / All sizes */}
        {filtered ? (
          <Link
            href={clearFilterHref}
            scroll={false}
            className="ml-auto font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 hover:text-[#2A1810]"
          >
            Tất cả kích cỡ
          </Link>
        ) : null}
      </nav>

      {/* Active Filter Pills (Desktop & Mobile) */}
      {filtered && activeSizeOption ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
            <span>Size: {activeSizeOption.label}</span>
            <Link
              href={clearFilterHref}
              scroll={false}
              aria-label={`Xóa bộ lọc size ${activeSizeOption.label}`}
              className="hover:text-black"
            >
              ✕
            </Link>
          </span>
        </div>
      ) : null}

      {/* Mobile Filter Drawer */}
      {isMobileOpen ? (
        <div
          id="mobile-collection-filters"
          role="dialog"
          aria-modal="true"
          aria-label="Bộ lọc sản phẩm"
          className="fixed inset-0 z-50 flex"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            aria-hidden="true"
            onClick={() => setIsMobileOpen(false)}
          />

          {/* Drawer content */}
          <div
            ref={drawerRef}
            className="relative ml-auto flex h-full w-full max-w-sm flex-col bg-[#FAF7F2] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#3B2219]/15 px-6 py-5">
              <h2 className="font-display text-xl text-[#2A1810]">Bộ lọc sản phẩm</h2>
              <button
                ref={closeBtnRef}
                type="button"
                onClick={() => setIsMobileOpen(false)}
                aria-label="Đóng bộ lọc"
                className="p-2 text-[#3B2219] hover:text-[#2A1810]"
              >
                ✕
              </button>
            </div>

            {/* Filter controls */}
            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
              {concreteSizes.length > 0 ? (
                <nav aria-label="Lọc theo kích cỡ">
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[#70584B] mb-3">
                    Kích cỡ
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {filtered ? (
                      <Link
                        href={clearFilterHref}
                        scroll={false}
                        onClick={() => setIsMobileOpen(false)}
                        className="min-w-9 rounded-md border border-[#3B2219]/25 px-3 py-2 text-center text-xs font-medium uppercase text-[#3B2219] transition"
                      >
                        Tất cả kích cỡ
                      </Link>
                    ) : null}
                    {concreteSizes.map((opt) => (
                      <Link
                        key={opt.value}
                        href={opt.href}
                        scroll={false}
                        aria-current={opt.active ? "true" : undefined}
                        onClick={() => setIsMobileOpen(false)}
                        className={`min-w-9 rounded-md border px-3 py-2 text-center text-xs font-medium uppercase transition ${
                          opt.active
                            ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                            : "border-[#3B2219]/25 text-[#3B2219]"
                        }`}
                      >
                        {opt.label}
                      </Link>
                    ))}
                  </div>
                </nav>
              ) : null}
            </div>

            {/* Drawer footer */}
            <div className="mobile-plp-filter-footer shrink-0 border-t border-[#3B2219]/15 bg-[#FAF7F2] px-6 py-4">
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href={clearFilterHref}
                  scroll={false}
                  onClick={() => setIsMobileOpen(false)}
                  className="btn btn--outline px-3"
                >
                  Xóa bộ lọc
                </Link>
                <button
                  type="button"
                  onClick={() => setIsMobileOpen(false)}
                  className="btn btn--primary px-3"
                >
                  Xem {totalCount} sản phẩm
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
