import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { PUBLIC_SIZE_GUIDE } from "@/content/public-brand-facts";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/**
 * The Size Guide's metadata. The unit is read from the tables rather than restated.
 *
 * It states no tolerance: La.na Design publishes none, and it describes body measurements rather
 * than product dimensions, which is the same distinction the page's own note draws.
 */

export type SizeGuideMetadataProps = StaticPageMetadataProps;

export async function buildSizeGuideMetadata(props: SizeGuideMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/size-guide",
    title: "Hướng dẫn chọn size",
    description: `Bảng thông số chọn size ${BRAND.identity.name}, số đo vòng cơ thể (${PUBLIC_SIZE_GUIDE.unit}) và khoảng chiều cao, cân nặng tham khảo.`,
  });
}
