import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { ABOUT_DESCRIPTION } from "../about-copy.ts";
import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

export type AboutMetadataProps = StaticPageMetadataProps;

export async function buildAboutMetadata(props: AboutMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/about",
    title: {
      absolute: `Về ${BRAND.identity.name} | Thời Trang Nữ Thiết Kế & Áo Dài Cao Cấp Từ 2022`,
    },
    description: ABOUT_DESCRIPTION,
  });
}
