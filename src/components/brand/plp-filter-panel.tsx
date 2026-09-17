"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import type { CategoryDiscoverySort } from "../../commerce/category-discovery-url";
import { handleDrawerFocusTrap } from "../headless/cart-drawer-model";
import {
  buildClearAllFiltersHref,
  buildSortChangeHref,
  buildToggleColorHref,
  buildToggleSaleHref,
  buildToggleSizeHref,
  countActivePlpFilters,
  formatFilterPriceVnd,
  hasActivePlpFilters,
  type PlpFilterState,
} from "../headless/plp-filter-model";

export type PlpFilterPanelProps = {
  categoryPath: string;
  totalCount: number;
  availableSizes: readonly string[];
  availableColors: readonly string[];
  activeFilters: PlpFilterState;
};

const SORT_OPTIONS: { value: CategoryDiscoverySort; label: string }[] = [
  { value: "default", label: "Thứ tự mặc định" },
  { value: "price-asc", label: "Giá: Thấp đến Cao" },
  { value: "price-desc", label: "Giá: Cao đến Thấp" },
  { value: "name-asc", label: "Tên: A đến Z" },
  { value: "name-desc", label: "Tên: Z đến A" },
];

export function PlpFilterPanel({
  categoryPath,
  totalCount,
  availableSizes,
  availableColors,
  activeFilters,
}: PlpFilterPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [minPriceInput, setMinPriceInput] = useState(
    activeFilters.minPriceVnd !== null ? String(activeFilters.minPriceVnd) : "",
  );
  const [maxPriceInput, setMaxPriceInput] = useState(
    activeFilters.maxPriceVnd !== null ? String(activeFilters.maxPriceVnd) : "",
  );

  const drawerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerButtonRef = useRef<HTMLElement | null>(null);
  const wasMobileOpenRef = useRef(false);

  const hasFilters = hasActivePlpFilters(activeFilters);
  const activeCount = countActivePlpFilters(activeFilters);

  // Manage body scroll, auto-focus, and focus restoration to opener
  useEffect(() => {
    if (isMobileOpen) {
      wasMobileOpenRef.current = true;
      if (!openerButtonRef.current) {
        openerButtonRef.current = document.activeElement as HTMLElement | null;
      }
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const timer = setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
      return () => {
        document.body.style.overflow = originalOverflow;
        clearTimeout(timer);
      };
    } else if (wasMobileOpenRef.current) {
      wasMobileOpenRef.current = false;
      openerButtonRef.current?.focus?.();
    }
  }, [isMobileOpen]);

  // Handle Escape to close drawer, and Tab to trap focus in mobile drawer
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

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSort = e.target.value as CategoryDiscoverySort;
    const href = buildSortChangeHref(categoryPath, activeFilters, nextSort);
    startTransition(() => {
      router.push(href);
    });
  };

  const handlePriceFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (activeFilters.color) params.set("color", activeFilters.color);
    if (activeFilters.size) params.set("size", activeFilters.size);
    if (activeFilters.sale) params.set("sale", "true");
    if (activeFilters.sort !== "default") params.set("sort", activeFilters.sort);

    const minVal = minPriceInput.trim() ? Number(minPriceInput.trim()) : null;
    const maxVal = maxPriceInput.trim() ? Number(maxPriceInput.trim()) : null;
    if (minVal !== null && Number.isSafeInteger(minVal) && minVal >= 0) {
      params.set("minPrice", String(minVal));
    }
    if (maxVal !== null && Number.isSafeInteger(maxVal) && maxVal >= 0) {
      params.set("maxPrice", String(maxVal));
    }

    const query = params.toString();
    const href = query ? `${categoryPath}?${query}` : categoryPath;
    startTransition(() => {
      router.push(href);
      setIsMobileOpen(false);
    });
  };

  const clearHref = buildClearAllFiltersHref(categoryPath);

  return (
    <div className="border-b border-[#3B2219]/15 pb-6">
      {/* Top action row: Count, mobile drawer button, desktop sort dropdown */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="text-xs uppercase tracking-wider text-[#3B2219]/70 font-sans">
          <span>{totalCount} sản phẩm</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Mobile Filter Button */}
          <button
            type="button"
            onClick={(e) => {
              openerButtonRef.current = e.currentTarget;
              setIsMobileOpen(true);
            }}
            aria-expanded={isMobileOpen}
            aria-controls="mobile-plp-filters"
            className="inline-flex items-center gap-2 rounded-full border border-[#3B2219]/25 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[#3B2219] transition hover:border-[#2A1810] hover:text-[#2A1810] md:hidden"
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
            {activeCount > 0 ? (
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#3B2219] text-[0.6rem] font-bold text-[#FAF7F2]">
                {activeCount}
              </span>
            ) : null}
          </button>

          {/* Sort Selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="plp-sort-select" className="text-xs uppercase tracking-wider text-[#3B2219]/70 hidden sm:inline">
              Sắp xếp:
            </label>
            <select
              id="plp-sort-select"
              aria-label="Sắp xếp sản phẩm"
              value={activeFilters.sort}
              onChange={handleSortChange}
              className="rounded border border-[#3B2219]/20 bg-transparent px-3 py-1.5 text-xs text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219]"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Desktop Filter Bar */}
      <div className="mt-6 hidden md:flex md:flex-wrap md:items-center md:gap-6 text-xs text-[#3B2219]">
        {/* Sale toggle */}
        <div>
          {(() => {
            const saleHref = buildToggleSaleHref(categoryPath, activeFilters);
            const isSaleActive = Boolean(activeFilters.sale);
            return (
              <Link
                href={saleHref}
                className={`inline-flex items-center rounded-full border px-3 py-1.5 font-medium transition ${
                  isSaleActive
                    ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                    : "border-[#3B2219]/20 hover:border-[#3B2219]"
                }`}
              >
                Sale
              </Link>
            );
          })()}
        </div>

        {/* Sizes */}
        {availableSizes.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[#3B2219]/60 mr-1">Size:</span>
            {availableSizes.map((size) => {
              const sizeHref = buildToggleSizeHref(categoryPath, activeFilters, size);
              const isSelected = activeFilters.size?.toLowerCase() === size.toLowerCase();
              return (
                <Link
                  key={size}
                  href={sizeHref}
                  className={`min-w-7 text-center rounded border px-2 py-1 font-medium uppercase transition ${
                    isSelected
                      ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                      : "border-[#3B2219]/20 hover:border-[#3B2219]"
                  }`}
                >
                  {size}
                </Link>
              );
            })}
          </div>
        ) : null}

        {/* Colors */}
        {availableColors.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[#3B2219]/60 mr-1">Màu:</span>
            {availableColors.slice(0, 6).map((color) => {
              const colorHref = buildToggleColorHref(categoryPath, activeFilters, color);
              const isSelected = activeFilters.color?.toLowerCase() === color.toLowerCase();
              return (
                <Link
                  key={color}
                  href={colorHref}
                  className={`rounded border px-2.5 py-1 font-medium transition ${
                    isSelected
                      ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                      : "border-[#3B2219]/20 hover:border-[#3B2219]"
                  }`}
                >
                  {color}
                </Link>
              );
            })}
          </div>
        ) : null}

        {/* Clear All */}
        {hasFilters ? (
          <Link
            href={clearHref}
            className="ml-auto font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 hover:text-[#2A1810]"
          >
            Xóa bộ lọc
          </Link>
        ) : null}
      </div>

      {/* Active Filter Pills (Desktop & Mobile) */}
      {hasFilters ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {activeFilters.sale ? (
            <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
              <span>Sale</span>
              {(() => {
                const href = buildToggleSaleHref(categoryPath, activeFilters);
                return (
                  <Link href={href} aria-label="Xóa bộ lọc sale" className="hover:text-black">
                    ✕
                  </Link>
                );
              })()}
            </span>
          ) : null}

          {activeFilters.size ? (
            <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
              <span>Size: {activeFilters.size}</span>
              {(() => {
                const href = buildToggleSizeHref(categoryPath, activeFilters, activeFilters.size!);
                return (
                  <Link href={href} aria-label={`Xóa bộ lọc size ${activeFilters.size}`} className="hover:text-black">
                    ✕
                  </Link>
                );
              })()}
            </span>
          ) : null}

          {activeFilters.color ? (
            <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
              <span>Màu: {activeFilters.color}</span>
              {(() => {
                const href = buildToggleColorHref(categoryPath, activeFilters, activeFilters.color!);
                return (
                  <Link href={href} aria-label={`Xóa bộ lọc màu ${activeFilters.color}`} className="hover:text-black">
                    ✕
                  </Link>
                );
              })()}
            </span>
          ) : null}

          {activeFilters.minPriceVnd !== null || activeFilters.maxPriceVnd !== null ? (
            <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
              <span>
                Giá:{" "}
                {activeFilters.minPriceVnd !== null
                  ? formatFilterPriceVnd(activeFilters.minPriceVnd)
                  : "0₫"}{" "}
                -{" "}
                {activeFilters.maxPriceVnd !== null
                  ? formatFilterPriceVnd(activeFilters.maxPriceVnd)
                  : "..."}
              </span>
              <Link href={clearHref} aria-label="Xóa khoảng giá" className="hover:text-black">
                ✕
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Mobile Filter Drawer */}
      {isMobileOpen ? (
        <div
          id="mobile-plp-filters"
          role="dialog"
          aria-modal="true"
          aria-label="Bộ lọc sản phẩm"
          className="fixed inset-0 z-50 flex"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => setIsMobileOpen(false)}
            aria-hidden="true"
          />

          {/* Drawer content */}
          <div
            ref={drawerRef}
            className="relative ml-auto flex h-full w-full max-w-sm flex-col bg-[#FAF7F2] p-6 shadow-2xl overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-[#3B2219]/15 pb-4">
              <h2 className="font-serif text-xl text-[#2A1810]">Bộ lọc sản phẩm</h2>
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
            <div className="mt-6 space-y-6 flex-1">
              {/* Sale */}
              <div>
                <span className="block text-xs font-semibold uppercase tracking-wider text-[#3B2219]/70 mb-3">
                  Ưu đãi
                </span>
                {(() => {
                  const saleHref = buildToggleSaleHref(categoryPath, activeFilters);
                  const isSaleActive = Boolean(activeFilters.sale);
                  return (
                    <Link
                      href={saleHref}
                      onClick={() => setIsMobileOpen(false)}
                      className={`inline-flex items-center rounded-full border px-4 py-2 text-xs font-medium uppercase tracking-wider transition ${
                        isSaleActive
                          ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                          : "border-[#3B2219]/25 text-[#3B2219]"
                      }`}
                    >
                      Chỉ xem sản phẩm Sale
                    </Link>
                  );
                })()}
              </div>

              {/* Sizes */}
              {availableSizes.length > 0 ? (
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[#3B2219]/70 mb-3">
                    Kích cỡ
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {availableSizes.map((size) => {
                      const sizeHref = buildToggleSizeHref(categoryPath, activeFilters, size);
                      const isSelected = activeFilters.size?.toLowerCase() === size.toLowerCase();
                      return (
                        <Link
                          key={size}
                          href={sizeHref}
                          onClick={() => setIsMobileOpen(false)}
                          className={`min-w-9 rounded border px-3 py-2 text-center text-xs font-medium uppercase transition ${
                            isSelected
                              ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                              : "border-[#3B2219]/25 text-[#3B2219]"
                          }`}
                        >
                          {size}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Colors */}
              {availableColors.length > 0 ? (
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[#3B2219]/70 mb-3">
                    Màu sắc
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {availableColors.map((color) => {
                      const colorHref = buildToggleColorHref(categoryPath, activeFilters, color);
                      const isSelected = activeFilters.color?.toLowerCase() === color.toLowerCase();
                      return (
                        <Link
                          key={color}
                          href={colorHref}
                          onClick={() => setIsMobileOpen(false)}
                          className={`rounded border px-3 py-2 text-xs font-medium transition ${
                            isSelected
                              ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                              : "border-[#3B2219]/25 text-[#3B2219]"
                          }`}
                        >
                          {color}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Price range form */}
              <div>
                <span className="block text-xs font-semibold uppercase tracking-wider text-[#3B2219]/70 mb-3">
                  Khoảng giá (₫)
                </span>
                <form onSubmit={handlePriceFilterSubmit} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      placeholder="Từ"
                      value={minPriceInput}
                      onChange={(e) => setMinPriceInput(e.target.value)}
                      className="w-full rounded border border-[#3B2219]/25 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                    />
                    <span>-</span>
                    <input
                      type="number"
                      placeholder="Đến"
                      value={maxPriceInput}
                      onChange={(e) => setMaxPriceInput(e.target.value)}
                      className="w-full rounded border border-[#3B2219]/25 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full rounded bg-[#3B2219] py-2 text-xs font-semibold uppercase tracking-wider text-[#FAF7F2] transition hover:bg-[#2A1810]"
                  >
                    Áp dụng giá
                  </button>
                </form>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="mt-8 border-t border-[#3B2219]/15 pt-4">
              <Link
                href={clearHref}
                onClick={() => setIsMobileOpen(false)}
                className="block w-full text-center py-2 text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline"
              >
                Xóa tất cả bộ lọc
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
