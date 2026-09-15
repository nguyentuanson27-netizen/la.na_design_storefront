import type { Metadata } from "next";

import { BRAND } from "@/brand";
import {
  describePublicSizeTolerance,
  PUBLIC_SIZE_GUIDE,
} from "@/content/public-brand-facts";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The Size Guide's metadata. Unit and tolerance are read from the tables, not restated. */

export type SizeGuideMetadataProps = StaticPageMetadataProps;

export async function buildSizeGuideMetadata(props: SizeGuideMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/size-guide",
    title: "Hướng dẫn chọn size",
    description: `Bảng thông số chọn size quần áo ${BRAND.identity.name}, số đo vòng sản phẩm (${PUBLIC_SIZE_GUIDE.unit}), dung sai ${describePublicSizeTolerance()} và khoảng chiều cao, cân nặng tham khảo.`,
  });
}
