import type { ReactNode } from "react";
import Link from "next/link";

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

export type ListingCrumb = Readonly<{ label: string; href?: string | null }>;

/**
 * The container every listing sits in: one max width, one gutter, one vertical rhythm.
 *
 * The rhythm is deliberately tighter than it was. Refinement spec "PLP / listing density" judges
 * these pages by one observable: on a product-bearing listing with its filters unexpanded, the top
 * edge of the first product image is inside the initial viewport at 1440x900 and at 390x844. Two
 * screens of chrome before the first photograph fails that on both.
 */
export function ListingShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-5 md:py-8">{children}</div>
  );
}

/**
 * The breadcrumb trail. The last crumb is the current page and carries no link, which is what
 * `aria-current` announces; passing it an href would make it a link to where the reader already is.
 */
export function ListingBreadcrumbs({
  items,
  className = "",
}: Readonly<{ items: readonly ListingCrumb[]; className?: string }>) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`text-xs uppercase tracking-[0.14em] text-[#3B2219]/70 ${className}`}
    >
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href ? (
              <Link className="transition-colors hover:text-[#2A1810]" href={crumb.href}>
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-[#2A1810]">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Eyebrow, serif H1 and whatever the route puts under them -- subcategory chips, an editorial
 * line, nothing at all.
 *
 * The heading is `font-normal`: master spec §9 asks for an elegant serif display, and weight is
 * what separates that from the condensed bold sans these pages used to shout in.
 */
export function ListingHeader({
  eyebrow,
  title,
  children,
}: Readonly<{ eyebrow?: string; title: string; children?: ReactNode }>) {
  return (
    <div className="mt-4 border-b border-[#3B2219]/15 pb-4">
      {eyebrow ? <p className="eyebrow text-[#70584B]">{eyebrow}</p> : null}
      <h1 className="mt-2 font-display text-3xl font-normal tracking-tight text-[#2A1810] sm:text-4xl md:text-5xl">
        {title}
      </h1>
      {children}
    </div>
  );
}

/**
 * The product grid: 4 across on desktop and 2 on mobile, as master spec §18 requires, with a
 * 3-column step so the cards do not stretch at tablet widths.
 *
 * It takes rendered children rather than a list of cards. The routes hold two different card
 * shapes (the category model is a bare `ProductCardModel`, the others pair it with an id for the
 * key) and different tone offsets, and inventing a third shape for them to adapt into would buy
 * nothing that a wrapper does not.
 */
export function ListingProductGrid({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="listing-product-grid grid grid-cols-2 gap-[2px] sm:gap-x-6 sm:gap-y-10 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-8 lg:gap-y-12">
      {children}
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
  return (
    <section aria-labelledby={titleId} className="py-20 text-center" data-ui-state="empty">
      <p className="eyebrow text-[#70584B]">{eyebrow}</p>
      <h2 id={titleId} className="mx-auto mt-4 max-w-2xl font-display text-2xl font-normal text-[#2A1810] md:text-3xl">
        {title}
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#3B2219]/70">{copy}</p>
      {action ? (
        <div className="mt-6">
          <Link
            href={action.href}
            className="listing-cta inline-flex min-h-11 items-center rounded-full border border-[#3B2219] bg-[#3B2219] px-6 py-2.5 text-xs font-semibold uppercase tracking-wider transition hover:bg-[#2A1810]"
          >
            {action.label}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Crawlable prev/next paging.
 *
 * The category PLP scrolls infinitely instead, on a server action built around its taxonomy key.
 * The other listings each page on their own query semantics, so they keep server-rendered links --
 * which §25 requires anyway: "SEO/crawlability must not depend solely on client-side scrolling".
 * Sharing the markup is what makes them look like one system; sharing the fetch would mean giving
 * four different queries one cursor.
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
  if (totalPages <= 1) return null;

  const linkClassName =
    "inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline underline-offset-4 transition-colors hover:text-[#2A1810]";

  return (
    <nav
      aria-label={label}
      className="mt-12 flex items-center justify-between gap-4 border-t border-[#3B2219]/15 pt-6"
    >
      {previousHref ? (
        <Link className={linkClassName} href={previousHref} rel="prev">
          ← Trang trước
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <p className="text-xs uppercase tracking-wider text-[#70584B]">
        Trang {page} / {totalPages}
      </p>
      {nextHref ? (
        <Link className={linkClassName} href={nextHref} rel="next">
          Trang sau →
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
