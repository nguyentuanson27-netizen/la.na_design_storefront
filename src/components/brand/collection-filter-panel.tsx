"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ListingResultCount } from "./listing-chrome";
import type {
  CollectionAvailabilityOption,
  CollectionSizeOption,
  CollectionSortOption,
} from "../../routes/collection-model";

export type CollectionFilterPanelProps = {
  totalCount: number;
  sortOptions: readonly CollectionSortOption[];
  sizeOptions: readonly CollectionSizeOption[];
  availabilityOption: CollectionAvailabilityOption;
};

/**
 * A collection's controls: result count, sort, the size chips and the "còn hàng" toggle.
 *
 * Size and stock are the only filters a collection has, so they sit in the page at every width
 * rather than behind a "Bộ lọc" drawer: on a phone the drawer cost two taps and a full-screen sheet
 * to reach four chips. There the row scrolls sideways under an edge fade, bleeding to the screen
 * edges, and every chip, the filter pill's remove control and the sort select are 44px touch
 * targets; from `md` they shrink to the desktop bar.
 */
export function CollectionFilterPanel({
  totalCount,
  sortOptions,
  sizeOptions,
  availabilityOption,
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
  // The "all sizes" entry keeps availability and sort, so clearing size never drops the other filter.
  const allSizesOption = sizeOptions.find((opt) => opt.value === null);
  const allSizesHref = allSizesOption?.href ?? "";
  const sizeFiltered = !(allSizesOption?.active ?? true);

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

      {concreteSizes.length > 0 ? (
        <nav aria-label="Lọc theo kích cỡ" className="-mx-6 mt-3 md:mx-0 md:mt-4">
          <div className="collection-size-row flex items-center gap-2 overflow-x-auto px-6 text-sm text-[#3B2219] md:flex-wrap md:gap-1.5 md:overflow-visible md:px-0 md:text-xs">
            <span className="mr-1 shrink-0 text-xs font-semibold uppercase tracking-wider text-[#70584B]">
              Size:
            </span>
            {/* "All" leads the row and is always there, current when nothing is picked: the way
                back is never scrolled off the end of the phone row, and picking a size changes
                which chip is filled rather than inserting one and shifting the rest. */}
            <Link
              href={allSizesHref}
              scroll={false}
              aria-label="Tất cả kích cỡ"
              aria-current={sizeFiltered ? undefined : "true"}
              className={`${chipClassName} ${
                sizeFiltered
                  ? "border-[#3B2219]/20 hover:border-[#3B2219]"
                  : "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
              }`}
            >
              Tất cả
            </Link>
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
        </nav>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={availabilityOption.href}
          scroll={false}
          aria-current={availabilityOption.active ? "true" : undefined}
          className={`${chipClassName} text-sm md:text-xs ${
            availabilityOption.active
              ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
              : "border-[#3B2219]/20 hover:border-[#3B2219]"
          }`}
        >
          Còn hàng
        </Link>
      </div>

      {/* Active filter pills; each remove control is a 44px target on a phone like the chips. */}
      {sizeFiltered && activeSizeOption ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-[#3B2219]/10 py-0 pl-2.5 pr-0 text-xs text-[#2A1810] md:gap-1.5 md:py-1 md:pr-2.5">
            <span>Size: {activeSizeOption.label}</span>
            <Link
              href={allSizesHref}
              scroll={false}
              aria-label={`Xóa bộ lọc size ${activeSizeOption.label}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-black md:min-h-0 md:min-w-0"
            >
              ✕
            </Link>
          </span>
        </div>
      ) : null}
    </div>
  );
}
