import type { Metadata } from "next";

import { BRAND } from "@/brand";

/** The account page's metadata. Static: the page is the same before and after signing in. */
export function buildAccountMetadata(): Metadata {
  return {
    title: "Tài khoản",
    description: `Đăng nhập hoặc tạo tài khoản ${BRAND.identity.name} để theo dõi đơn hàng thuận tiện hơn.`,
  };
}
