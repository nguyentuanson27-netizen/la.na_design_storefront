"use client";

import type { ReactNode } from "react";
import Link from "@/i18n/link";

import { LISTING_ACTION_BAR_CLASSES } from "@/components/headless/listing-view-model";

import { useT } from "@/i18n/client";

import { ListingViewToggle } from "./listing-view";

/**
 * The listing surfaces' shared presentation.
 *
 * Every storefront listing -- category, `/new-arrivals`, `/sale`, `/shop`, `/collections` and a
 * collection's own page -- draws the same chrome: breadcrumb, eyebrow, serif H1, then the grid or
 * the empty state. Before this module each of them spelled that out again, which is how one page
 * ended up with a 9rem bold sans heading and the next with a 4rem serif one over the same kind of
 * content.
 *
 * What lives here is presentation and nothing else: no query parsing, no href building, no
 * category key. Each route keeps its own data and URL semantics and hands the result in, because
 * those genuinely differ -- the category PLP filters on a taxonomy key, `/sale` on an active
 * promotion, `/shop` on a free-text query -- and collapsing them into one component would mean
 * changing what a route means in order to share how it looks.
 *
 * The visual reference is the category PLP, which is the surface master spec §25 describes.
 */

/*
 * The shell, breadcrumb and heading are every storefront page's, not only the listings': they live
 * in `page-chrome` and are re-exported here under the names the listing routes already use.
 */
export {
  PageBreadcrumbs as ListingBreadcrumbs,
  PageHeader as ListingHeader,
  PageShell as ListingShell,
  type PageCrumb as ListingCrumb,
} from "./page-chrome";

export type ListingSubnavItem = Readonly<{
  label: string;
  /** The accessible name, when the visible label leans on the heading above it for context. */
  fullLabel?: string;
  href: string;
  current?: boolean;
}>;

/**
 * The row of sibling listings under a heading: small-caps text tabs, the current one underlined.
 *
 * It replaced a wrap of bordered pills that took two rows (~120px) on a 390px phone before the
 * result count and filters even began. The row is one line at every width: on a phone it scrolls
 * sideways under a fade that shows there is more, bleeding to the screen edges so the first tab
 * lines up with the heading; from `md` up it simply wraps, which in practice means it fits.
 * Its colours and the drawn-in underline live in `globals.css` (`.listing-subnav-link`), since a
 * pseudo-element underline is clearer there than as a stack of `after:` utilities.
 */
export function ListingSubnav({
  label,
  items,
}: Readonly<{ label: string; items: readonly ListingSubnavItem[] }>) {
  const t = useT();
  return (
    <nav aria-label={t(label)} className="-mx-6 mt-2 md:mx-0">
      <ul className="listing-subnav flex gap-x-6 overflow-x-auto px-6 md:flex-wrap md:gap-x-8 md:overflow-visible md:px-0">
        {items.map((item) => (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              aria-label={item.fullLabel && item.fullLabel !== item.label ? t(item.fullLabel) : undefined}
              className="listing-subnav-link inline-flex min-h-11 items-center whitespace-nowrap font-display text-xs uppercase tracking-[0.14em]"
            >
              {t(item.label)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The product grid. Its columns follow the shopper's chosen view (`listing-view`): by default 4
 * across on desktop and 2 on mobile, as master spec §18 requires, with a 3-column step so the cards
 * do not stretch at tablet widths; a smaller photograph size packs more of them into the row.
 *
 * It takes rendered children rather than a list of cards. The routes hold two different card
 * shapes (the category model is a bare `ProductCardModel`, the others pair it with an id for the
 * key) and different tone offsets, and inventing a third shape for them to adapt into would buy
 * nothing that a wrapper does not.
 */
export { ListingProductGrid, ListingViewToggle } from "./listing-view";

/**
 * The action bar of a listing that has nothing to filter or sort -- `/new-arrivals`,
 * `/offers/eligible`, the collections index -- drawn from the same classes as the bars that do, so
 * the view toggle sits where it sits on the category listing, `/sale`, `/shop` and a collection:
 * left, 36px buttons, one row. The result count is not drawn; a visually hidden live copy keeps it
 * available to assistive technology. `rule` draws the line under the bar that separates it from the
 * products; the collections index turns it off, as its cards are covers and not a product grid.
 */
export function ListingViewBar({
  totalCount,
  countLabel = "sản phẩm",
  rule = true,
  className = "",
}: Readonly<{ totalCount: number; countLabel?: string; rule?: boolean; className?: string }>) {
  const t = useT();
  return (
    <div className={`${rule ? "border-b border-[#3B2219]/15 pb-3 md:pb-4" : ""} ${className}`}>
      <div className={LISTING_ACTION_BAR_CLASSES.bar}>
        <span role="status" className="sr-only">
          {totalCount} {t(countLabel)}
        </span>
        <ListingViewToggle compact className="shrink-0" />
      </div>
    </div>
  );
}

/** The line above a grid that says how much is in it, and optionally what is filtering it. */
export function ListingResultCount({
  children,
  live = false,
}: Readonly<{ children: ReactNode; live?: boolean }>) {
  return (
    <p
      aria-live={live ? "polite" : undefined}
      className="text-xs uppercase tracking-wider text-[#70584B]"
    >
      {children}
    </p>
  );
}

/**
 * The empty state. One shape for "nothing here yet" and "nothing matched", because the difference
 * between them is the copy and the recovery link, not the layout.
 */
export function ListingEmptyState({
  eyebrow,
  title,
  copy,
  action,
  titleId,
}: Readonly<{
  eyebrow: string;
  title: string;
  copy: string;
  action?: Readonly<{ href: string; label: string }>;
  titleId: string;
}>) {
  const t = useT();
  return (
    <section aria-labelledby={titleId} className="py-20 text-center" data-ui-state="empty">
      <p className="eyebrow text-[#70584B]">{t(eyebrow)}</p>
      <h2 id={titleId} className="mx-auto mt-4 max-w-2xl font-display text-2xl font-normal text-[#2A1810] md:text-3xl">
        {t(title)}
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#3B2219]/70">{t(copy)}</p>
      {action ? (
        <div className="mt-6">
          <Link
            href={action.href}
            className="btn btn--primary"
          >
            {t(action.label)}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The way back from an infinite grid that opened on a later page.
 *
 * The grid continues forward from the page the URL named, so the pages before it are reached by this
 * link -- which is also what lets a crawler walk the listing backwards. Absent on the first page.
 */
export function ListingPreviousLink({ href }: Readonly<{ href: string | null }>) {
  const t = useT();
  if (href === null) return null;
  return (
    <p className="mt-8">
      <Link
        className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 transition-colors hover:text-[#2A1810]"
        href={href}
        rel="prev"
      >
        {t("← Trang trước")}
      </Link>
    </p>
  );
}

/**
 * Crawlable prev/next paging.
 *
 * The category PLP, a collection and the sale listings scroll infinitely instead, each on a server
 * action built around its own scope (they still carry a real next-page link, which §25 requires:
 * "SEO/crawlability must not depend solely on client-side scrolling"). The listings left on this
 * pager page on their own query semantics, so they keep server-rendered links. Sharing the markup
 * is what makes them look like one system; sharing the fetch would mean giving different queries
 * one cursor.
 */
export function ListingPagination({
  label,
  page,
  totalPages,
  previousHref,
  nextHref,
}: Readonly<{
  label: string;
  page: number;
  totalPages: number;
  previousHref: string | null;
  nextHref: string | null;
}>) {
  const t = useT();
  if (totalPages <= 1) return null;

  const linkClassName =
    "inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 transition-colors hover:text-[#2A1810]";

  return (
    <nav
      aria-label={t(label)}
      className="mt-12 flex items-center justify-between gap-4 border-t border-[#3B2219]/15 pt-6"
    >
      {previousHref ? (
        <Link className={linkClassName} href={previousHref} rel="prev">
          {t("← Trang trước")}
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <p className="text-xs uppercase tracking-wider text-[#70584B]">
        {t("Trang {page} / {totalPages}", { page, totalPages })}
      </p>
      {nextHref ? (
        <Link className={linkClassName} href={nextHref} rel="next">
          {t("Trang sau →")}
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
