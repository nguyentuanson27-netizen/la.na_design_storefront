"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
} from "react";

import { buildStorefrontDiscoveryHref } from "../../commerce/storefront-discovery";
import { formatFilterPriceVnd } from "../headless/plp-filter-model";
import { handleDrawerFocusTrap } from "../headless/cart-drawer-model";
import {
  normalizeShopPriceInput,
  validateShopPriceRange,
} from "../headless/shop-price-range-model";
import { useScrollLock } from "../headless/use-scroll-lock";
import type { ShopCollectionFacet, ShopViewModel } from "../../routes/shop-model";

/**
 * A `/shop` control that applies itself.
 *
 * The page is one native GET form, so a filter only took effect after the shopper found the
 * "Áp dụng" button. These submit the form the moment the value changes -- through
 * `requestSubmit`, so the price fields' validity still gets its say -- and the page resets to its
 * first page because the form carries no `page`.
 */
export function ShopFilterSelect({
  onChange,
  ...props
}: ComponentPropsWithoutRef<"select">) {
  return (
    <select
      {...props}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
        onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}

export function ShopFilterCheckbox({
  onChange,
  ...props
}: Omit<ComponentPropsWithoutRef<"input">, "type">) {
  return (
    <input
      {...props}
      type="checkbox"
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}

export type ShopPriceRangeProps = {
  limitVnd: number;
  minPriceVnd: number | null;
  maxPriceVnd: number | null;
  inputClassName: string;
  separatorClassName?: string;
};

/**
 * The two price boxes of a `/shop` form.
 *
 * Plain text with a numeric keypad rather than `type="number"`: a number input accepts `1e5` and
 * rounds to its `step`, and either way the loader answered with a 404. The browser's own validation
 * bubble carries the message, so it works at every width and without further markup.
 */
export function ShopPriceRange({
  limitVnd,
  minPriceVnd,
  maxPriceVnd,
  inputClassName,
  separatorClassName,
}: ShopPriceRangeProps) {
  const [min, setMin] = useState(minPriceVnd !== null ? String(minPriceVnd) : "");
  const [max, setMax] = useState(maxPriceVnd !== null ? String(maxPriceVnd) : "");
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);

  // Applied URL changes (a pill's remove link, "Xóa bộ lọc") must reach the boxes.
  const [applied, setApplied] = useState({ minPriceVnd, maxPriceVnd });
  if (applied.minPriceVnd !== minPriceVnd || applied.maxPriceVnd !== maxPriceVnd) {
    setApplied({ minPriceVnd, maxPriceVnd });
    setMin(minPriceVnd !== null ? String(minPriceVnd) : "");
    setMax(maxPriceVnd !== null ? String(maxPriceVnd) : "");
  }

  useEffect(() => {
    const issue = validateShopPriceRange({ min, max, limitVnd });
    minRef.current?.setCustomValidity(issue?.field === "min" ? issue.message : "");
    maxRef.current?.setCustomValidity(issue?.field === "max" ? issue.message : "");
  }, [min, max, limitVnd]);

  return (
    <>
      <input
        ref={minRef}
        type="text"
        inputMode="numeric"
        name="minPrice"
        aria-label="Giá tối thiểu"
        placeholder="Từ"
        autoComplete="off"
        value={min}
        onChange={(event) => setMin(normalizeShopPriceInput(event.target.value))}
        className={inputClassName}
      />
      <span className={separatorClassName}>-</span>
      <input
        ref={maxRef}
        type="text"
        inputMode="numeric"
        name="maxPrice"
        aria-label="Giá tối đa"
        placeholder="Đến"
        autoComplete="off"
        value={max}
        onChange={(event) => setMax(normalizeShopPriceInput(event.target.value))}
        className={inputClassName}
      />
    </>
  );
}

export type ShopMobileDrawerProps = {
  limits: ShopViewModel["limits"];
  discovery: ShopViewModel["discovery"];
  collectionFacets: readonly ShopCollectionFacet[];
  colorFacets: readonly string[];
  sizeFacets: readonly string[];
  /** The chosen values as the facets spell them, so the selects do not fall back to "all". */
  selectedCollection: string;
  selectedSize: string;
  selectedColor: string;
  activeFilterCount: number;
};

export function ShopMobileDrawer({
  limits,
  discovery,
  collectionFacets,
  colorFacets,
  sizeFacets,
  selectedCollection,
  selectedSize,
  selectedColor,
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
      {/* Sale has no control on /shop, but a link can filter by it: the form must carry it. */}
      {discovery.sale ? <input type="hidden" name="sale" value="true" /> : null}

      {/* The filter fields only exist while the drawer is open. Closed, the form still has to carry
          the applied filters, or searching or re-sorting from the bar would silently drop them. */}
      {!isOpen ? (
        <>
          {discovery.collection ? (
            <input type="hidden" name="collection" value={discovery.collection} />
          ) : null}
          {discovery.size ? <input type="hidden" name="size" value={discovery.size} /> : null}
          {discovery.color ? <input type="hidden" name="color" value={discovery.color} /> : null}
          {discovery.availability ? (
            <input type="hidden" name="availability" value={discovery.availability} />
          ) : null}
          {discovery.minPriceVnd !== null ? (
            <input type="hidden" name="minPrice" value={discovery.minPriceVnd} />
          ) : null}
          {discovery.maxPriceVnd !== null ? (
            <input type="hidden" name="maxPrice" value={discovery.maxPriceVnd} />
          ) : null}
        </>
      ) : null}

      {/* Mobile Drawer Trigger Button (visible only on mobile) */}
      <button
        type="button"
        onClick={(e) => {
          openerButtonRef.current = e.currentTarget;
          setIsOpen(true);
        }}
        aria-expanded={isOpen}
        aria-controls="mobile-shop-drawer"
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

            {/* These controls belong to the one mobile /shop form rendered by the page. */}
            <div className="flex flex-1 flex-col justify-between overflow-y-auto">
              <div className="space-y-6 px-6 py-6">

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
                    aria-label="Bộ sưu tập"
                    defaultValue={selectedCollection}
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
                    aria-label="Kích cỡ"
                    defaultValue={selectedSize}
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
                    aria-label="Màu sắc"
                    defaultValue={selectedColor}
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
                    <ShopPriceRange
                      limitVnd={limits.priceVnd}
                      minPriceVnd={discovery.minPriceVnd}
                      maxPriceVnd={discovery.maxPriceVnd}
                      inputClassName="w-full rounded border border-[#3B2219]/20 bg-transparent px-3 py-2 text-xs text-[#2A1810]"
                      separatorClassName="text-xs text-[#70584B]"
                    />
                  </div>
                </div>
              </div>

              {/* Drawer Fixed Footer */}
              <div className="border-t border-[#3B2219]/15 p-4 bg-[#FAF7F2] flex items-center gap-3">
                <Link
                  href="/shop"
                  onClick={() => setIsOpen(false)}
                  className="btn btn--outline flex-1"
                >
                  Xóa bộ lọc
                </Link>
                <button
                  type="submit"
                  className="btn btn--primary flex-1"
                >
                  Áp dụng
                </button>
              </div>
            </div>
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

      {discovery.sale ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-[#3B2219]/10 px-2.5 py-1 text-xs text-[#2A1810]">
          <span>Sale</span>
          <Link
            href={buildStorefrontDiscoveryHref({ ...discovery, sale: null, page: 1 })}
            aria-label="Xóa bộ lọc sale"
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
