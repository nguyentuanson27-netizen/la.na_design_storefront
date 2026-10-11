import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

export type AboutMetadataProps = StaticPageMetadataProps;

export async function buildAboutMetadata(props: AboutMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/about",
    title: {
      absolute: `Về ${BRAND.identity.name} | Thời Trang Nữ Thiết Kế & Áo Dài Cao Cấp Từ 2022`,
    },
    description:
      "Thành lập từ năm 2022, La.na Design là thương hiệu thời trang nữ thiết kế cao cấp, nổi bật với áo dài cách tân 4 tà, đầm tiệc và set đồ thanh lịch, tôn vinh nét duyên Việt.",
  });
}
