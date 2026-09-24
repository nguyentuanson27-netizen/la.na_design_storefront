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
          className="mt-6 min-h-11 border border-black bg-black px-5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
          type="button"
          onClick={reset}
        >
          Thử lại
        </button>
      </div>
    </PageShell>
  );
}
