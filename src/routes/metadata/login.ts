import type { Metadata } from "next";

import { BRAND } from "@/brand";

/** The login page's metadata. Static: the page is the same before and after signing in. */
export function buildLoginMetadata(): Metadata {
  return {
    title: "Đăng nhập",
    description: `Đăng nhập hoặc tạo tài khoản ${BRAND.identity.name} để theo dõi đơn hàng thuận tiện hơn.`,
  };
}
