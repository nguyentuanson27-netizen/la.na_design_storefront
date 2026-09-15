import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { describePublicReturnWindow } from "@/content/public-brand-facts";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The Returns policy page's metadata. The window comes from the policy, not from the sentence. */

export type ReturnsMetadataProps = StaticPageMetadataProps;

export async function buildReturnsMetadata(props: ReturnsMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/returns",
    title: "Chính sách đổi trả và hoàn tiền",
    description: `Đổi trả trong ${describePublicReturnWindow()}, điều kiện sản phẩm, phí đổi và thời gian hoàn tiền của ${BRAND.identity.name}.`,
  });
}
