"use client";

import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { useT } from "@/components/brand/localization";

export default function CartError({ reset }: { reset: () => void }) {
  const t = useT();
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Giỏ hàng" }]} />
      <PageHeader eyebrow={t("Mua sắm")} title={t("Giỏ hàng")} />
      <div className="mt-8">
        <p className="font-display text-xl md:text-2xl">{t("Không thể tải giỏ hàng lúc này.")}</p>
        <button
          className="btn btn--primary mt-6"
          type="button"
          onClick={reset}
        >
          {t("Thử lại")}
        </button>
      </div>
    </PageShell>
  );
}
