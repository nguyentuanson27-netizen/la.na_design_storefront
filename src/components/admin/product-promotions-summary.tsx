import Link from "next/link";
import type { RelatedCampaignSummary } from "@/commerce/promotion-admin-repository";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Nháp",
  SCHEDULED: "Đã lên lịch",
  ACTIVE: "Đang chạy",
  ENDED: "Đã kết thúc",
  DISABLED: "Đã tắt",
};

const SCOPE_LABELS: Record<string, string> = {
  PRODUCT: "Toàn bộ sản phẩm",
  VARIANT: "Phiên bản cụ thể",
  BOTH: "Cả sản phẩm và phiên bản",
};

export type ProductPromotionsSummaryProps = Readonly<{
  campaigns: readonly RelatedCampaignSummary[];
}>;

export function ProductPromotionsSummary({ campaigns }: ProductPromotionsSummaryProps) {
  return (
    <section aria-labelledby="product-promotions-heading" className="mt-8 border border-black/20 bg-black/[0.02] p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">Khuyến mãi</p>
          <h2 className="mt-1 font-display text-2xl tracking-[-0.03em]" id="product-promotions-heading">
            Chiến dịch liên quan
          </h2>
        </div>
        <Link
          className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-800 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/admin/promotions"
        >
          Xem tất cả khuyến mãi →
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-700">
          Chưa có chiến dịch khuyến mãi nào áp dụng trực tiếp cho sản phẩm hoặc phiên bản này.
        </p>
      ) : (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-700">
            {campaigns.length} chiến dịch liên quan:
          </p>
          <ul className="mt-3 divide-y divide-black/10 text-sm">
            {campaigns.map((campaign) => (
              <li className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between" key={campaign.id}>
                <div>
                  <Link
                    className="font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                    href={`/admin/promotions?q=${encodeURIComponent(campaign.name)}`}
                  >
                    {campaign.name}
                  </Link>
                  <span className="ml-2 text-xs text-neutral-700">
                    ({campaign.kind === "FLASH_SALE" ? "Flash Sale" : "Khuyến mãi"})
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-neutral-800">
                  <span className="rounded bg-black/10 px-2 py-0.5 font-medium text-neutral-900">
                    {SCOPE_LABELS[campaign.targetScope] ?? campaign.targetScope}
                  </span>
                  <span className="font-semibold text-black">
                    {STATUS_LABELS[campaign.status] ?? campaign.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
