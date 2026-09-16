import type { NavigationConfig } from "./schema.ts";

/**
 * The storefront menus. Configuration rather than markup because the category set is the part that
 * changes per brand: one shop needs shirts and trousers where another needs áo dài, váy and sets.
 *
 * Link order is the rendered order.
 *
 * A3 replaced the two entries that state the brand's name -- the wordmark link's accessible name
 * and the About label -- because those are brand identity, not route identity, which is also why
 * `brandHomeLabel` is in the brand-leak needle set. The menu hierarchy, order and destinations are
 * still the inherited Brand #1 ones and stay that way until every new destination exists; A6 cuts
 * them over atomically then.
 */
export const NAVIGATION: NavigationConfig = {
  brandHomeLabel: "La.na Design — Trang chủ",
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
    { href: "/about", label: "Về La.na Design" },
    { href: "/shipping", label: "Vận chuyển" },
    { href: "/returns", label: "Đổi trả" },
    { href: "/size-guide", label: "Bảng size" },
    { href: "/contact", label: "Liên hệ" },
    { href: "/account", label: "Tài khoản" },
  ],
};
