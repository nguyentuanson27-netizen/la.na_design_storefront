"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildStorefrontDiscoveryHref } from "../../commerce/storefront-discovery";
import { formatFilterPriceVnd } from "../headless/plp-filter-model";
import { handleDrawerFocusTrap } from "../headless/cart-drawer-model";
import { useScrollLock } from "../headless/use-scroll-lock";
import type { ShopCollectionFacet, ShopViewModel } from "../../routes/shop-model";

export type ShopMobileDrawerProps = {
  limits: ShopViewModel["limits"];
  discovery: ShopViewModel["discovery"];
  collectionFacets: readonly ShopCollectionFacet[];
  colorFacets: readonly string[];
  sizeFacets: readonly string[];
  activeFilterCount: number;
};

export function ShopMobileDrawer({
  limits,
  discovery,
  collectionFacets,
  colorFacets,
  sizeFacets,
  activeFilterCount,
}: ShopMobileDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerButtonRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Lock scroll cleanly via the site's canonical useScrollLock hook
  useScrollLock(isOpen);

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      if (!openerButtonRef.current) {
        openerButtonRef.current = document.activeElement as HTMLElement | null;
      }
      const timer = setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      openerButtonRef.current?.focus?.();
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
      } else if (e.key === "Tab") {
        handleDrawerFocusTrap(e, drawerRef.current);
      }
    },
    [isOpen],
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  return (
    <>
      {/* Mobile Drawer Trigger Button (visible only on mobile) */}
      <button
        type="button"
        onClick={(e) => {
          openerButtonRef.current = e.currentTarget;
          setIsOpen(true);
        }}
        aria-expanded={isOpen}
        aria-controls="mobile-shop-drawer"
        className="inline-flex items-center gap-2 rounded-full border border-[#3B2219]/25 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[#3B2219] transition hover:border-[#2A1810] hover:text-[#2A1810] md:hidden"
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
        {activeFilterCount > 0 ? (
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#3B2219] text-[0.6rem] font-bold text-[#FAF7F2]">
            {activeFilterCount}
          </span>
        ) : null}
      </button>

      {/* Slide-out Drawer */}
      {isOpen ? (
        <div
          id="mobile-shop-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-shop-drawer-title"
          className="fixed inset-0 z-50 flex justify-end md:hidden"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          {/* Drawer panel */}
          <div
            ref={drawerRef}
            className="relative z-10 flex h-full w-full max-w-sm flex-col bg-[#FAF7F2] shadow-2xl"
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-[#3B2219]/15 px-6 py-4">
              <h2
                id="mobile-shop-drawer-title"
                className="text-sm font-semibold uppercase tracking-wider text-[#2A1810]"
              >
                Bộ lọc
              </h2>
              <button
                ref={closeBtnRef}
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Đóng bộ lọc"
                className="rounded-full p-2 text-[#3B2219]/70 hover:bg-[#3B2219]/10 hover:text-[#2A1810]"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Drawer Form */}
            <form
              method="get"
              action="/shop"
              className="flex flex-1 flex-col justify-between overflow-y-auto"
            >
              <div className="space-y-6 px-6 py-6">
                {/* Carry existing query & sort */}
                <input type="hidden" name="q" value={discovery.query ?? ""} />
                <input type="hidden" name="sort" value={discovery.sort} />

                {/* Stock status */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      name="availability"
                      value="in-stock"
                      defaultChecked={discovery.availability === "in-stock"}
                      className="h-4 w-4 rounded border-[#3B2219]/30 accent-[#3B2219]"
                    />
                    <span className="text-xs font-semibold uppercase tracking-wider text-[#70584B]">
                      Chỉ còn hàng
                    </span>
                  </label>
                </div>

                {/* Collection */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#70584B] mb-2">
                    Bộ sưu tập
                  </label>
                  <select
                    name="collection"
                    defaultValue={discovery.collection ?? ""}
                    className="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                  >
                    <option value="">Tất cả bộ sưu tập</option>
                    {collectionFacets.map((col) => (
                      <option key={col.value} value={col.value}>
                        {col.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Size */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#70584B] mb-2">
                    Kích cỡ
                  </label>
                  <select
                    name="size"
                    defaultValue={discovery.size ?? ""}
                    className="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                  >
                    <option value="">Tất cả kích cỡ</option>
                    {sizeFacets.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Color */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#70584B] mb-2">
                    Màu sắc
                  </label>
                  <select
                    name="color"
                    defaultValue={discovery.color ?? ""}
                    className="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                  >
                    <option value="">Tất cả màu sắc</option>
                    {colorFacets.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Price range */}
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[#70584B] mb-2">
                    Khoảng giá (₫)
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      name="minPrice"
                      placeholder="Từ"
                      min={0}
                      max={limits.priceVnd}
                      step={1000}
                      defaultValue={discovery.minPriceVnd ?? ""}
                      className="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                    />
                    <span className="text-xs text-[#70584B]">-</span>
                    <input
                      type="number"
                      name="maxPrice"
                      placeholder="Đến"
                      min={0}
                      max={limits.priceVnd}
                      step={1000}
                      defaultValue={discovery.maxPriceVnd ?? ""}
                      className="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                    />
                  </div>
                </div>
              </div>

              {/* Drawer Fixed Footer */}
              <div className="border-t border-[#3B2219]/15 p-4 bg-[#FAF7F2] flex items-center gap-3">
                <Link
                  href="/shop"
                  onClick={() => setIsOpen(false)}
                  className="flex-1 text-center py-2.5 text-xs font-semibold uppercase tracking-wider text-[#3B2219] border border-[#3B2219]/30 rounded-full hover:bg-[#3B2219]/5 transition"
                >
                  Xóa bộ lọc
                </Link>
                <button
                  type="submit"
                  className="flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#FAF7F2] bg-[#3B2219] border border-[#3B2219] rounded-full hover:bg-[#2A1810] transition"
                >
                  Áp dụng
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

export type ShopActiveFiltersProps = {
  discovery: ShopViewModel["discovery"];
  collectionFacets: readonly ShopCollectionFacet[];
  filtered: boolean;
};

export function ShopActiveFilters({
  discovery,
  collectionFacets,
  filtered,
}: ShopActiveFiltersProps) {
  if (!filtered) return null;

  const activeCollectionFacet = collectionFacets.find(
    (c) => c.value === discovery.collection,
  );

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {discovery.query ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>Tìm: &ldquo;{discovery.query}&rdquo;</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, query: null, page: 1 })}
            aria-label="Xóa từ khóa tìm kiếm"
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      {discovery.collection ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>BST: {activeCollectionFacet?.label ?? discovery.collection}</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, collection: null, page: 1 })}
            aria-label="Xóa bộ lọc bộ sưu tập"
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      {discovery.size ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>Size: {discovery.size}</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, size: null, page: 1 })}
            aria-label={`Xóa bộ lọc size ${discovery.size}`}
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      {discovery.color ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>Màu: {discovery.color}</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, color: null, page: 1 })}
            aria-label={`Xóa bộ lọc màu ${discovery.color}`}
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      {discovery.availability === "in-stock" ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>Chỉ còn hàng</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, availability: null, page: 1 })}
            aria-label="Xóa bộ lọc chỉ còn hàng"
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      {discovery.minPriceVnd !== null || discovery.maxPriceVnd !== null ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>
            Giá:{" "}
            {discovery.minPriceVnd !== null
              ? formatFilterPriceVnd(discovery.minPriceVnd)
              : "0₫"}{" "}
            -{" "}
            {discovery.maxPriceVnd !== null
              ? formatFilterPriceVnd(discovery.maxPriceVnd)
              : "..."}
          </span>
          <Link
            href={buildStorefrontDiscoveryHref({
              ...discovery,
              minPriceVnd: null,
              maxPriceVnd: null,
              page: 1,
            })}
            aria-label="Xóa khoảng giá"
            className="hover:text-black"
          >
            ✕
          </Link>
        </span>
      ) : null}

      <Link
        href="/shop"
        className="text-xs font-medium text-[#70584B] underline underline-offset-2 hover:text-[#3B2219] ml-1"
      >
        Xóa tất cả
      </Link>
    </div>
  );
}
