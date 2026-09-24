"use client";

import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";

export default function ShopError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Cửa hàng" }]} />
      <PageHeader eyebrow="Mua sắm" title="Cửa hàng" />
      <section className="mt-8 max-w-3xl" aria-labelledby="shop-error-title">
        <h2 id="shop-error-title" className="font-display text-xl md:text-2xl">
          Không thể tải sản phẩm lúc này.
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-6 text-[#3B2219]/70">
          Vui lòng thử lại. Nếu danh mục vừa được cập nhật, sản phẩm mới sẽ xuất hiện khi kết nối ổn định trở lại.
        </p>
        <button
          className="btn btn--primary mt-6"
          type="button"
          onClick={() => reset()}
        >
          Thử lại
        </button>
      </section>
    </PageShell>
  );
}
