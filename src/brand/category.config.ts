import type { NavigationLink } from "./schema.ts";

/**
 * The Brand #2 category vocabulary: one ordered declaration of every crawlable category route.
 *
 * It lives in `src/brand` because it is brand vocabulary, not route plumbing — a fork sells
 * something other than áo dài, and renaming or reordering these is a brand decision. Everything
 * downstream derives from this list rather than restating it: navigation (`navigation.config.ts`),
 * the route manifest, the sitemap's static canonical paths and the indexable-path patterns. That is
 * what keeps `brand-leak.test.ts` green — the slugs and labels appear exactly once in the tree —
 * and it is why adding a category is a single edit here rather than four edits that can disagree.
 *
 * F3a owns crawlable route identity only. Product membership deliberately stays absent: G4 approves
 * the one canonical Brand #2 category authority, and collection slugs are editorial collection
 * state that must not become category truth by naming convention.
 */
export type CategoryDefinition = NavigationLink & Readonly<{
  /** Stable code-facing name, so a page module can select its category without repeating the slug. */
  key: string;
  children?: readonly CategoryDefinition[];
}>;

export const CATEGORY_NAVIGATION: readonly CategoryDefinition[] = [
  {
    key: "aoDai",
    href: "/ao-dai",
    label: "Áo dài",
    children: [
      { key: "aoDaiCachTan", href: "/ao-dai/cach-tan", label: "Áo dài cách tân" },
      { key: "aoDaiTet", href: "/ao-dai/tet", label: "Áo dài Tết" },
      { key: "aoDaiCuoi", href: "/ao-dai/cuoi", label: "Áo dài cưới" },
      { key: "aoDai4Ta", href: "/ao-dai/4-ta", label: "Áo dài 4 tà" },
      { key: "aoDai6Ta", href: "/ao-dai/6-ta", label: "Áo dài 6 tà" },
    ],
  },
  {
    key: "setDo",
    href: "/set-do",
    label: "Set đồ",
    children: [
      { key: "setVay", href: "/set-do/set-vay", label: "Set váy" },
      { key: "setQuanAo", href: "/set-do/set-quan-ao", label: "Set quần áo" },
    ],
  },
  { key: "vayDam", href: "/vay-dam", label: "Váy, đầm" },
  { key: "phuKien", href: "/phu-kien", label: "Phụ kiện" },
];

/**
 * Every category, parent before its own children, in navigation order.
 *
 * The flattening is shared because each consumer needs the same traversal, and three hand-written
 * copies of it is how the order silently drifts between the navigation, the manifest and the
 * sitemap.
 */
export const FLATTENED_CATEGORIES: readonly CategoryDefinition[] = CATEGORY_NAVIGATION.flatMap(
  (category) => [category, ...(category.children ?? [])],
);

/** Every category route path, in the same order. */
export const CATEGORY_ROUTE_PATHS: readonly string[] = FLATTENED_CATEGORIES.map(
  (category) => category.href,
);
