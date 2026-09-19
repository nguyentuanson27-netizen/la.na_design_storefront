import { CATEGORY_NAVIGATION } from "./category.config.ts";
import type { NavigationConfig, NavigationLink } from "./schema.ts";

type PrimaryNavigationLink = NavigationLink & Readonly<{
  children?: readonly PrimaryNavigationLink[];
}>;

type NavigationWithPrimaryHierarchy = Omit<NavigationConfig, "primary"> & Readonly<{
  primary: readonly PrimaryNavigationLink[];
}>;

/**
 * Brand #2 navigation cutover. The hierarchy is presentation/config state only: these route links do
 * not establish product membership or turn editorial collections into the canonical category
 * authority. G4 owns that later category-membership decision.
 */
export const NAVIGATION: NavigationWithPrimaryHierarchy = {
  brandHomeLabel: "La.na Design — Trang chủ",
  primary: [
    // The category block is `CATEGORY_NAVIGATION` verbatim, in its declared order. Restating the
    // slugs and labels here is what `brand-leak.test.ts` fails on, and it is also how the navigation
    // and the routes that serve it drift apart.
    ...CATEGORY_NAVIGATION,
    { href: "/new-arrivals", label: "Hàng mới về" },
    { href: "/collections", label: "Bộ sưu tập" },
    { href: "/sale", label: "Sale" },
  ],
  mobileUtility: [
    { href: "/search", label: "Tìm kiếm" },
    { href: "/account", label: "Tài khoản" },
  ],
  utility: [
    { href: "/search", label: "Tìm kiếm" },
    { href: "/account", label: "Tài khoản" },
    { href: "/cart", label: "Giỏ hàng" },
  ],
  footer: [
    { href: "/ao-dai", label: "Áo dài" },
    { href: "/set-do", label: "Set đồ" },
    { href: "/vay-dam", label: "Váy, đầm" },
    { href: "/new-arrivals", label: "Hàng mới về" },
    { href: "/sale", label: "Sale" },
    { href: "/collections", label: "Bộ sưu tập" },
  ],
};
