import type { Metadata } from "next";

import { buildProductMetadata } from "@/routes/metadata/product";

/**
 * The PDP keeps its metadata here because it needs the product before it can build a title -- the
 * one route in the manifest whose metadata is not on the page. The work itself lives in the
 * canonical builder; this segment only declares where it is declared.
 */

type ProductLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}>;

export async function generateMetadata({
  params,
}: Omit<ProductLayoutProps, "children">): Promise<Metadata> {
  return buildProductMetadata({ params });
}

export default function ProductLayout({ children }: ProductLayoutProps) {
  return children;
}
