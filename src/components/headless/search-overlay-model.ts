import { FLATTENED_CATEGORIES } from "../../brand/category.config.ts";

export type SearchSuggestionCategory = Readonly<{
  key: string;
  label: string;
  href: string;
}>;

export type SearchSuggestionProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  primaryImageUrl: string | null;
  priceText: string | null;
}>;

export type SearchSuggestionsResult = Readonly<{
  query: string;
  categories: readonly SearchSuggestionCategory[];
  products: readonly SearchSuggestionProduct[];
  error?: string | null;
}>;

/**
 * Strips diacritics / Vietnamese accents for robust substring search.
 */
export function removeVietnameseAccents(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Matches categories from the approved taxonomy against a query string.
 * When query is empty, returns top-level categories.
 */
export function matchTaxonomyCategories(query: string): readonly SearchSuggestionCategory[] {
  const normalizedQuery = removeVietnameseAccents(query.trim());

  if (normalizedQuery.length === 0) {
    // Default top-level categories (paths with only one slash)
    return FLATTENED_CATEGORIES.filter((category) => !category.href.includes("/", 1)).map(
      (category) => ({
        key: category.key,
        label: category.label,
        href: category.href,
      }),
    );
  }

  return FLATTENED_CATEGORIES.filter((category) => {
    const normalizedLabel = removeVietnameseAccents(category.label);
    const normalizedKey = category.key.toLowerCase();
    const normalizedHref = category.href.replace(/\//g, " ").replace(/-/g, " ");
    return (
      normalizedLabel.includes(normalizedQuery) ||
      normalizedKey.includes(normalizedQuery) ||
      normalizedHref.includes(normalizedQuery)
    );
  }).map((category) => ({
    key: category.key,
    label: category.label,
    href: category.href,
  }));
}

/**
 * Builds an accessible polite live region announcement for search status.
 */
export function buildSearchAnnouncement(
  query: string,
  isLoading: boolean,
  productCount: number,
  categoryCount: number,
): string {
  if (isLoading) {
    return "Đang tìm kiếm...";
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const total = productCount + categoryCount;
  if (total === 0) {
    return `Không tìm thấy kết quả nào cho "${trimmed}".`;
  }
  const parts: string[] = [];
  if (productCount > 0) {
    parts.push(`${productCount} sản phẩm`);
  }
  if (categoryCount > 0) {
    parts.push(`${categoryCount} danh mục`);
  }
  return `Tìm thấy ${parts.join(" và ")} cho "${trimmed}".`;
}

export { STOREFRONT_DISCOVERY_LIMITS } from "../../commerce/storefront-discovery.ts";
