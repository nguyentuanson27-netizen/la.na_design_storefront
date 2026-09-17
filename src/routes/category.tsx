import Link from "next/link";

import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { categoryByKey, categoryByPath } from "@/commerce/category-taxonomy";
import { buildCategoryBreadcrumbStructuredData } from "@/seo/category-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";
import { CATEGORY_DESTINATIONS, type CategoryDestination } from "./category-destinations.ts";
import { resolveCategoryBreadcrumbs, type CategoryBreadcrumb } from "./category-breadcrumbs.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

export { CATEGORY_DESTINATIONS };
export type { CategoryDestination };

export type CategoryRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export type CategoryViewModel = Readonly<{
  destination: CategoryDestination;
  breadcrumbs: readonly CategoryBreadcrumb[];
  subcategories: readonly Readonly<{ label: string; href: string }>[];
}>;

export async function loadCategoryRoute(
  destination: CategoryDestination,
  props: CategoryRouteProps,
): Promise<RouteHandle<CategoryViewModel>> {
  void props;
  const exposure = readSearchExposure();
  const node = categoryByPath(destination.href);
  const breadcrumbs = node ? resolveCategoryBreadcrumbs(node.key) : [];

  const subcategories = (node?.childKeys ?? [])
    .map((childKey) => {
      const childNode = categoryByKey(childKey);
      return childNode ? { label: childNode.label, href: childNode.path } : null;
    })
    .filter((item): item is { label: string; href: string } => item !== null);

  const structuredData = [
    buildCategoryBreadcrumbStructuredData({
      origin: exposure.origin,
      items: breadcrumbs.map((b) => ({ name: b.label, href: b.href })),
    }),
  ];

  return sealRoute({
    data: Object.freeze({
      destination,
      breadcrumbs,
      subcategories: Object.freeze(subcategories),
    }),
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData,
    pixelEvents: [],
  });
}

export function renderCategoryRoute(data: CategoryViewModel) {
  const { destination, breadcrumbs, subcategories } = data;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-12 md:py-20">
      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-[#3B2219]/70">
        <ol className="flex flex-wrap items-center gap-2">
          {breadcrumbs.map((crumb, idx) => (
            <li key={idx} className="flex items-center gap-2">
              {idx > 0 ? <span aria-hidden="true">/</span> : null}
              {crumb.href ? (
                <Link className="hover:text-[#2A1810] transition-colors" href={crumb.href}>
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-[#2A1810] font-medium">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-8 border-b border-[#3B2219]/15 pb-8">
        <p className="eyebrow text-[#70584B]">Danh mục thiết kế</p>
        <h1 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-normal text-[#2A1810] tracking-tight">
          {destination.label}
        </h1>

        {subcategories.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {subcategories.map((sub) => (
              <Link
                key={sub.href}
                href={sub.href}
                className="inline-flex items-center rounded-full border border-[#3B2219]/20 px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-[#3B2219] transition hover:border-[#2A1810] hover:bg-[#2A1810] hover:text-[#FAF7F2]"
              >
                {sub.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-8">
        <Link
          className="inline-flex items-center text-xs font-semibold uppercase tracking-[0.14em] text-[#3B2219] underline underline-offset-4 hover:text-[#2A1810]"
          href="/shop"
        >
          Khám phá tất cả sản phẩm
        </Link>
      </div>
    </div>
  );
}
