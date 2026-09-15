import type { Metadata } from "next";

import { BRAND } from "@/brand";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The Contact page's metadata. */

export type ContactMetadataProps = StaticPageMetadataProps;

export async function buildContactMetadata(props: ContactMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/contact",
    title: "Liên hệ",
    description: `Hotline, Zalo, email, địa chỉ và giờ hỗ trợ của ${BRAND.identity.name} — các kênh liên hệ chính thức.`,
  });
}
