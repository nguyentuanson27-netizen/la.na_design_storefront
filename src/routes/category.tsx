import Link from "next/link";

import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { CATEGORY_DESTINATIONS, type CategoryDestination } from "./category-destinations.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

export { CATEGORY_DESTINATIONS };
export type { CategoryDestination };

export type CategoryRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export type CategoryViewModel = Readonly<{ destination: CategoryDestination }>;

export async function loadCategoryRoute(
  destination: CategoryDestination,
  props: CategoryRouteProps,
): Promise<RouteHandle<CategoryViewModel>> {
  void props;
  return sealRoute({
    data: Object.freeze({ destination }),
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}

export function renderCategoryRoute(data: CategoryViewModel) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Danh mục</p>
      <h1 className="mt-4 max-w-5xl text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        {data.destination.label}
      </h1>
      <Link className="mt-8 inline-block underline" href="/shop">
        Xem toàn bộ sản phẩm
      </Link>
    </div>
  );
}
