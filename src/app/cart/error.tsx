"use client";

import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";

export default function CartError({ reset }: { reset: () => void }) {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Giỏ hàng" }]} />
      <PageHeader eyebrow="Mua sắm" title="Giỏ hàng" />
      <div className="mt-8">
        <p className="font-display text-xl md:text-2xl">Không thể tải giỏ hàng lúc này.</p>
        <button
          className="btn btn--primary mt-6"
          type="button"
          onClick={reset}
        >
          Thử lại
        </button>
      </div>
    </PageShell>
  );
}
