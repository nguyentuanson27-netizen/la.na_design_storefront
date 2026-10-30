import type { Metadata } from "next";

/** A cart-scoped offer list is never a public search landing page. */
export function buildEligibleOffersMetadata(): Metadata {
  return {
    title: "Sản phẩm áp dụng ưu đãi",
    description: "Gợi ý những sản phẩm phù hợp với chương trình ưu đãi và giỏ hàng hiện tại.",
    robots: { index: false, follow: false },
  };
}
