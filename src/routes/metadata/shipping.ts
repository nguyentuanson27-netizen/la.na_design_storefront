import type { Metadata } from "next";

import { BRAND } from "@/brand";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The Shipping & Payment policy page's metadata. */

export type ShippingMetadataProps = StaticPageMetadataProps;

export async function buildShippingMetadata(props: ShippingMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/shipping",
    title: "Chính sách vận chuyển và thanh toán",
    description: `Phạm vi giao hàng, đơn vị vận chuyển, thời gian dự kiến và phương thức thanh toán của ${BRAND.identity.name}.`,
  });
}
