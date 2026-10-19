"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ListingResultCount } from "./listing-chrome";
import type { CollectionSizeOption, CollectionSortOption } from "../../routes/collection-model";

export type CollectionFilterPanelProps = {
  totalCount: number;
  sortOptions: readonly CollectionSortOption[];
  sizeOptions: readonly CollectionSizeOption[];
  clearFilterHref: string;
  filtered: boolean;
};

/**
 * A collection's controls: result count, sort, and the size chips.
 *
 * Size is the only filter a collection has, so the chips sit in the page at every width rather
 * than behind a "Bộ lọc" drawer: on a phone the drawer cost two taps and a full-screen sheet to
 * reach four chips. There the row scrolls sideways, bleeding to the screen edges, and every chip
 * and the sort select are 44px touch targets; from `md` they shrink to the desktop bar.
 */
export function CollectionFilterPanel({
  totalCount,
  sortOptions,
  sizeOptions,
  clearFilterHref,
  filtered,
}: CollectionFilterPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

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

  const chipClassName =
    "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border px-3 font-medium uppercase transition md:min-h-0 md:min-w-7 md:px-2 md:py-1";

  return (
    <div className="border-b border-[#3B2219]/15 pb-4">
      {/* Top action row: count, sort */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ListingResultCount>{totalCount} sản phẩm</ListingResultCount>

        <nav aria-label="Sắp xếp bộ sưu tập" className="flex items-center gap-2">
          <label
            htmlFor="collection-sort-select"
            className="text-xs uppercase tracking-wider text-[#3B2219]/70"
          >
            Sắp xếp:
          </label>
          {/* 16px on a phone: iOS zooms the page into any smaller form control it focuses. */}
          <select
            id="collection-sort-select"
            aria-label="Sắp xếp sản phẩm"
            value={activeSortHref}
            onChange={handleSortChange}
            className="min-h-11 rounded border border-[#3B2219]/20 bg-transparent px-3 text-base text-[#2A1810] focus-visible:outline-2 focus-visible:outline-[#3B2219] md:min-h-0 md:py-1.5 md:text-xs"
          >
            {sortOptions.map((opt) => (
              <option key={opt.value} value={opt.href}>
                {opt.label}
              </option>
            ))}
          </select>
        </nav>
      </div>

      {concreteSizes.length > 0 || filtered ? (
        <nav aria-label="Lọc theo kích cỡ" className="-mx-6 mt-3 md:mx-0 md:mt-4">
          <div className="flex items-center gap-2 overflow-x-auto px-6 text-sm text-[#3B2219] [scrollbar-width:none] md:flex-wrap md:gap-x-6 md:gap-y-3 md:overflow-visible md:px-0 md:text-xs">
            {concreteSizes.length > 0 ? (
              <div className="flex shrink-0 items-center gap-2 md:gap-1.5">
                <span className="mr-1 shrink-0 text-xs font-semibold uppercase tracking-wider text-[#70584B]">
                  Size:
                </span>
                {concreteSizes.map((opt) => (
                  <Link
                    key={opt.value}
                    href={opt.href}
                    scroll={false}
                    aria-current={opt.active ? "true" : undefined}
                    className={`${chipClassName} ${
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
                className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 hover:text-[#2A1810] md:ml-auto md:min-h-0"
              >
                Tất cả kích cỡ
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}

      {/* Active filter pill */}
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
    </div>
  );
}
