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
    {
      href: "/ao-dai",
      label: "Áo dài",
      children: [
        { href: "/ao-dai/cach-tan", label: "Áo dài cách tân" },
        { href: "/ao-dai/tet", label: "Áo dài Tết" },
        { href: "/ao-dai/cuoi", label: "Áo dài cưới" },
        { href: "/ao-dai/4-ta", label: "Áo dài 4 tà" },
        { href: "/ao-dai/6-ta", label: "Áo dài 6 tà" },
      ],
    },
    {
      href: "/set-do",
      label: "Set đồ",
      children: [
        { href: "/set-do/set-vay", label: "Set váy" },
        { href: "/set-do/set-quan-ao", label: "Set quần áo" },
      ],
    },
    { href: "/vay-dam", label: "Váy, đầm" },
    { href: "/phu-kien", label: "Phụ kiện" },
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
    { href: "/shop", label: "Cửa hàng" },
    { href: "/new-arrivals", label: "Hàng mới" },
    { href: "/track-order", label: "Tra cứu đơn" },
    { href: "/about", label: "Về La.na Design" },
    { href: "/shipping", label: "Vận chuyển" },
    { href: "/returns", label: "Đổi trả" },
    { href: "/size-guide", label: "Bảng size" },
    { href: "/contact", label: "Liên hệ" },
    { href: "/account", label: "Tài khoản" },
  ],
};
