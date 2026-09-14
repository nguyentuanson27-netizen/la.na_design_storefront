import type { NavigationConfig } from "./schema.ts";

/**
 * The storefront menus. Configuration rather than markup because the category set is the part that
 * changes per brand: a menswear shop needs shirts and trousers where a womenswear shop needs
 * dresses and sets.
 *
 * Link order is the rendered order.
 */
export const NAVIGATION: NavigationConfig = {
  brandHomeLabel: "LA Clothing — Trang chủ",
  primary: [
    { href: "/shop", label: "Cửa hàng" },
    { href: "/new-arrivals", label: "Hàng mới" },
    { href: "/collections", label: "Bộ sưu tập" },
    { href: "/lookbook", label: "Lookbook" },
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
    { href: "/lookbook", label: "Lookbook" },
    { href: "/track-order", label: "Tra cứu đơn" },
    { href: "/about", label: "Về LA Clothing" },
    { href: "/shipping", label: "Vận chuyển" },
    { href: "/returns", label: "Đổi trả" },
    { href: "/size-guide", label: "Bảng size" },
    { href: "/contact", label: "Liên hệ" },
    { href: "/account", label: "Tài khoản" },
  ],
};
