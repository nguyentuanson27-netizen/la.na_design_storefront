const SCHEMA_CONTEXT = "https://schema.org" as const;

export type CategoryBreadcrumbStructuredDataDocument = {
  "@context": typeof SCHEMA_CONTEXT;
  "@type": "BreadcrumbList";
  itemListElement: Array<{
    "@type": "ListItem";
    position: number;
    name: string;
    item?: string;
  }>;
};

export function buildCategoryBreadcrumbStructuredData({
  origin,
  items,
}: Readonly<{
  origin: string;
  items: readonly Readonly<{ name: string; href?: string }>[];
}>): CategoryBreadcrumbStructuredDataDocument {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem" as const,
      position: index + 1,
      name: item.name,
      ...(item.href ? { item: new URL(item.href, origin).href } : {}),
    })),
  };
}
