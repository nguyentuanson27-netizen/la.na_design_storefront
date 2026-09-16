import type { NavigationConfig } from "./schema.ts";

/**
 * The storefront menus. Configuration rather than markup because the category set is the part that
 * changes per brand: one shop needs shirts and trousers where another needs áo dài, váy and sets.
 *
 * Link order is the rendered order. A6 cuts the active primary navigation to the approved Brand #2
 * hierarchy only after F3a has made every destination crawlable.
 */
export const NAVIGATION: NavigationConfig = {
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
