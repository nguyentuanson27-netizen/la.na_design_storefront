/**
 * English for the copy that lives in Brand Config: navigation, hours and the like.
 *
 * Brand Config owns every brand string, and `brand-leak.test.ts` fails if one is written anywhere
 * else -- a catalog entry keyed by a brand string is exactly that. So the English for brand copy is
 * declared here, beside the Vietnamese it translates, and merged into the catalog by
 * `src/i18n/catalog/en.ts`. Keys are the Vietnamese source text, as everywhere in the catalog.
 */
export const BRAND_MESSAGES_EN: Readonly<Record<string, string>> = {
  "La.na Design — Trang chủ": "La.na Design — Home",
  "08:00 - 22:00 hằng ngày (UTC+7)": "08:00 - 22:00 daily (UTC+7)",
  "Về La.na Design": "About La.na Design",

  // Navigation labels
  "Áo dài": "Ao dai",
  "Áo dài cách tân": "Modern ao dai",
  "Áo dài Tết": "Tet ao dai",
  "Áo dài cưới": "Wedding ao dai",
  "Áo dài 4 tà": "4-panel ao dai",
  "Áo dài 6 tà": "6-panel ao dai",
  "Set đồ": "Sets",
  "Set váy": "Dress sets",
  "Set quần áo": "Pants & top sets",
  "Váy, đầm": "Dresses",
  "Phụ kiện": "Accessories",
  "Hàng mới về": "New arrivals",
  "Bộ sưu tập": "Collections",
  "Sale": "Sale",
  "Ưu đãi": "Offers",
  "Flash Sale": "Flash Sale",
  "Xả hàng lẻ size": "Odd-size clearance",
  "Tìm kiếm": "Search",
  "Tài khoản": "Account",
  "Giỏ hàng": "Cart",
};
