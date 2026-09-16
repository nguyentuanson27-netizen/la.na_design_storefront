import Link from "next/link";

import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { sealRoute, type RouteHandle } from "./core.tsx";

export type CategoryDestination = Readonly<{ href: string; label: string }>;

/**
 * F3a owns crawlable route identity only. Product membership deliberately stays absent here until
 * G4 approves one canonical Brand #2 category authority; collection slugs are editorial collection
 * state and must not become category truth by naming convention.
 */
export const CATEGORY_DESTINATIONS = Object.freeze({
  aoDai: { href: "/ao-dai", label: "Áo dài" },
  aoDaiCachTan: { href: "/ao-dai/cach-tan", label: "Áo dài cách tân" },
  aoDaiTet: { href: "/ao-dai/tet", label: "Áo dài Tết" },
  aoDaiCuoi: { href: "/ao-dai/cuoi", label: "Áo dài cưới" },
  aoDai4Ta: { href: "/ao-dai/4-ta", label: "Áo dài 4 tà" },
  aoDai6Ta: { href: "/ao-dai/6-ta", label: "Áo dài 6 tà" },
  setDo: { href: "/set-do", label: "Set đồ" },
  setVay: { href: "/set-do/set-vay", label: "Set váy" },
  setQuanAo: { href: "/set-do/set-quan-ao", label: "Set quần áo" },
  vayDam: { href: "/vay-dam", label: "Váy, đầm" },
  phuKien: { href: "/phu-kien", label: "Phụ kiện" },
} satisfies Record<string, CategoryDestination>);

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
