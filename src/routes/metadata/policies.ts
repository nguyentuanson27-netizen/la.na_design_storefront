import type { Metadata } from "next";

import { BRAND } from "@/brand";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The policy hub's metadata. It names the topics it indexes and promises nothing beyond them. */

export type PoliciesMetadataProps = StaticPageMetadataProps;

export async function buildPoliciesMetadata(props: PoliciesMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/policies",
    title: "Thông tin & chính sách",
    description: `Chính sách vận chuyển, thanh toán, đổi trả và hoàn tiền, thông tin liên hệ, các hình thức hỗ trợ trực tuyến và tiếp nhận khiếu nại của ${BRAND.identity.name}.`,
  });
}
