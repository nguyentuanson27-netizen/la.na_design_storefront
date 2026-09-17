import { categoryAncestorKeys, categoryByKey } from "../commerce/category-taxonomy.ts";

export type CategoryBreadcrumb = Readonly<{
  label: string;
  href?: string;
}>;

/**
 * Resolves the parent -> child breadcrumb hierarchy for a category key (F3b).
 * Returns: Trang chủ (/) -> Ancestor Categories (in order) -> Current Category.
 */
export function resolveCategoryBreadcrumbs(categoryKey: string): readonly CategoryBreadcrumb[] {
  const node = categoryByKey(categoryKey);
  if (!node) {
    return Object.freeze([{ label: "Trang chủ", href: "/" }]);
  }

  const ancestorKeys = categoryAncestorKeys(categoryKey);
  const breadcrumbs: CategoryBreadcrumb[] = [{ label: "Trang chủ", href: "/" }];

  for (const ancestorKey of ancestorKeys) {
    const ancestor = categoryByKey(ancestorKey);
    if (ancestor) {
      breadcrumbs.push({ label: ancestor.label, href: ancestor.path });
    }
  }

  breadcrumbs.push({ label: node.label });
  return Object.freeze(breadcrumbs);
}
