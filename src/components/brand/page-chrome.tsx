import type { ReactNode } from "react";
import Link from "next/link";

/**
 * The head every storefront page shares: container, breadcrumb, eyebrow and display H1.
 *
 * The listing pages converged on this first (see `listing-chrome`). The account, cart, checkout,
 * order-tracking and content pages kept their own copies -- a 9rem bold sans H1 on some, a 72px
 * display one on others, each over its own gutter and padding -- so moving from a category to the
 * login page changed the type system under the reader. What lives here is presentation only; each
 * route keeps its own data and copy and hands them in.
 */

export type PageCrumb = Readonly<{ label: string; href?: string | null }>;

/**
 * The container every storefront page sits in: one max width, one gutter, one vertical rhythm.
 *
 * The rhythm is deliberately tighter than it was. Refinement spec "PLP / listing density" judges
 * these pages by one observable: on a product-bearing listing with its filters unexpanded, the top
 * edge of the first product image is inside the initial viewport at 1440x900 and at 390x844. Two
 * screens of chrome before the first photograph fails that on both.
 */
export function PageShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-5 md:py-8">{children}</div>
  );
}

/**
 * The breadcrumb trail. The last crumb is the current page and carries no link, which is what
 * `aria-current` announces; passing it an href would make it a link to where the reader already is.
 */
export function PageBreadcrumbs({
  items,
  className = "",
}: Readonly<{ items: readonly PageCrumb[]; className?: string }>) {
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
 * Eyebrow, H1, an optional lead line and whatever the route puts under them -- subcategory tabs,
 * a form, nothing at all -- closed by the hairline the page body starts under.
 *
 * The heading is `font-normal` display type at 30/36/48px: master spec §9 asks for an elegant
 * display, and weight is what separates that from the 9rem bold sans the account, cart, checkout
 * and content pages each used to shout their titles in. `meta` is the short fact set on the
 * heading's baseline at the far edge ("3 sản phẩm", "Thanh toán khi nhận hàng").
 */
export function PageHeader({
  eyebrow,
  title,
  lead,
  meta,
  children,
}: Readonly<{
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}>) {
  const heading = (
    <h1 className="mt-2 font-display text-3xl font-normal tracking-tight text-[#2A1810] sm:text-4xl md:text-5xl">
      {title}
    </h1>
  );

  return (
    <div className="mt-4 border-b border-[#3B2219]/15 pb-4">
      {eyebrow ? <p className="eyebrow text-[#70584B]">{eyebrow}</p> : null}
      {meta ? (
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          {heading}
          <p className="pb-1 text-xs uppercase tracking-wider text-[#70584B]">{meta}</p>
        </div>
      ) : (
        heading
      )}
      {lead ? (
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#3B2219]/75 md:text-base md:leading-7">
          {lead}
        </p>
      ) : null}
      {children}
    </div>
  );
}
