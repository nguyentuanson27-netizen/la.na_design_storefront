import type { Metadata } from "next";
import Link from "next/link";

import { requireCurrentAdminPage } from "@/auth/current-admin";
import { isPromotionActivationEnabled } from "@/commerce/promotion-activation";
import { createPromotionAdminRepository } from "@/commerce/promotion-admin-repository";
import {
  MAX_ADMIN_PROMOTION_PAGE_SIZE,
  describePromotionFailure,
  type PromotionAdminFailure,
} from "@/commerce/promotion-admin-feedback";
import { PromotionAdminStatus } from "@/components/admin/promotion-admin-status";
import { PromotionCampaignForm } from "@/components/admin/promotion-campaign-form";
import { PROMOTION_CAMPAIGN_KIND_LABELS } from "@/commerce/promotion-pricing";
import { evaluateCampaignRuntimeHealth } from "@/commerce/promotion-runtime-health";
import { prisma } from "@/db/prisma";

import {
  copyPromotionAction,
  createPromotionAction,
  disablePromotionAction,
  editPromotionAction,
  endPromotionEarlyAction,
  publishPromotionAction,
} from "./actions";

export const metadata: Metadata = { title: "Quản lý khuyến mãi" };

const repository = createPromotionAdminRepository(prisma);

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Nháp",
  SCHEDULED: "Đã lên lịch",
  ACTIVE: "Đang chạy",
  ENDED: "Đã kết thúc",
  DISABLED: "Đã tắt",
};

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

/** The reasons this page will render. An unrecognised value falls back to a generic sentence. */
const FAILURE_REASONS = new Set<string>([
  "ACTIVATION_DISABLED", "CAMPAIGN_NOT_FOUND", "ILLEGAL_TRANSITION", "INVALID_CAMPAIGN",
  "INVALID_DRAFT_INPUT", "TARGET_EXPANSION_LIMIT_EXCEEDED", "NO_EFFECTIVE_DISCOUNT",
  "UNUSABLE_BASE_PRICE", "OVERLAPPING_CAMPAIGN", "DUPLICATE_TARGET",
  "MALFORMED_FIXED_PRICE", "INVALID_PERCENTAGE",
  "INVALID_CAMPAIGN_KIND", "INVALID_DISCOUNT_TYPE", "INVALID_DATE_TIME",
  "FORBIDDEN",
]);

const buttonClassName =
  "min-h-11 border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";

type PromotionsPageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
    reason?: string | string[];
    new?: string | string[];
    edit?: string | string[];
  }>;
};

function singleValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function describeDiscount(row: { discountType: string; percentageValue: number | null; fixedPriceVnd: bigint | null }) {
  if (row.discountType === "PERCENTAGE" && row.percentageValue !== null) {
    return `Giảm ${row.percentageValue}%`;
  }
  if (row.fixedPriceVnd !== null) return `Giá cố định ${currency.format(Number(row.fixedPriceVnd))}`;
  return "Chưa cấu hình";
}

export default async function PromotionsAdminPage({ searchParams }: PromotionsPageProps) {
  await requireCurrentAdminPage();

  const query = await searchParams;
  const search = singleValue(query.q);
  const statusKind = singleValue(query.status);
  const isNew = singleValue(query.new) === "1";
  const editId = singleValue(query.edit);
  // The URL carries only a typed reason. The sentence is resolved here, on the server, so a
  // hand-edited query string cannot put arbitrary text on an admin screen.
  const failureReason = singleValue(query.reason);
  const failureMessage =
    failureReason !== null && FAILURE_REASONS.has(failureReason)
      ? describePromotionFailure({ reason: failureReason } as PromotionAdminFailure).message
      : null;
  const requestNow = new Date();

  const campaigns = await repository.listCampaigns({ search, now: requestNow });
  const campaignToEdit = editId ? await repository.getCampaignForEdit(editId, requestNow) : null;
  const campaignRuntimeHealth = campaignToEdit
    ? await evaluateCampaignRuntimeHealth({ campaignId: campaignToEdit.id, now: requestNow })
    : null;
  // Read on the server for display only. The gate is enforced by the activation service; this
  // banner exists so an operator understands why publishing is refused, not to decide anything.
  const activationEnabled = isPromotionActivationEnabled();

  return (
    <div>
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Khuyến mãi</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-black/65">
            Danh sách chiến dịch khuyến mãi, Flash Sale và xả hàng lẻ size do website sở hữu. Giá hiệu lực, quy tắc
            trùng lặp và vòng đời đều do máy chủ quyết định.
          </p>
        </div>
        <div>
          {isNew || editId ? (
            <Link className={buttonClassName} href="/admin/promotions">
              ← Quay lại danh sách
            </Link>
          ) : (
            <Link className={buttonClassName} href="/admin/promotions?new=1">
              + Tạo chiến dịch mới
            </Link>
          )}
        </div>
      </header>

      {!activationEnabled ? (
        <p
          className="mt-8 border-l-2 border-black bg-black/[0.03] px-4 py-3 text-sm leading-6"
          role="note"
        >
          <strong className="font-semibold">Kích hoạt khuyến mãi đang tắt.</strong> Bạn vẫn có thể
          soạn và sao chép chiến dịch, nhưng thao tác bật chiến dịch sẽ bị máy chủ từ chối cho đến
          khi cấu hình triển khai được mở.
        </p>
      ) : null}

      <form className="mt-8 flex flex-wrap items-end gap-4" role="search">
        <div className="min-w-64 flex-1">
          <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor="promotion-search">
            Tìm theo tên chiến dịch
          </label>
          <input
            className="mt-2 w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
            defaultValue={search ?? ""}
            id="promotion-search"
            name="q"
            type="search"
          />
        </div>
        <button className={buttonClassName} type="submit">
          Tìm
        </button>
      </form>

      <PromotionAdminStatus
        kind={statusKind === "ok" ? "success" : statusKind === "error" ? "error" : null}
        message={
          statusKind === "ok"
            ? "Đã lưu thay đổi."
            : statusKind === "error"
              ? failureMessage
                ?? "Không thực hiện được thao tác. Hãy tải lại trang và thử lại."
              : null
        }
      />

      {isNew ? (
        <section aria-labelledby="new-campaign-heading" className="mt-8 border border-black/20 bg-black/[0.01] p-6">
          <h2 className="text-xl font-semibold tracking-[-0.02em]" id="new-campaign-heading">
            Tạo chiến dịch mới
          </h2>
          <p className="mt-1 text-xs text-neutral-700">
            Chiến dịch tạo mới sẽ ở trạng thái Nháp (Draft) và không tự kích hoạt trừ khi được Bật.
          </p>
          <div className="mt-6 border-t border-black/10 pt-6">
            <PromotionCampaignForm action={createPromotionAction} mode="create" />
          </div>
        </section>
      ) : null}

      {editId ? (
        <section aria-labelledby="edit-campaign-heading" className="mt-8 border border-black/20 bg-black/[0.01] p-6">
          {campaignToEdit ? (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="text-xl font-semibold tracking-[-0.02em]" id="edit-campaign-heading">
                  Chỉnh sửa: {campaignToEdit.name}
                </h2>
                <p className="text-xs uppercase tracking-[0.14em] text-neutral-800">
                  Trạng thái: <strong>{STATUS_LABELS[campaignToEdit.status] ?? campaignToEdit.status}</strong>
                </p>
                {campaignRuntimeHealth ? (
                  <p className="text-xs uppercase tracking-[0.14em] text-neutral-800">
                    Sức khỏe vận hành: <strong>{campaignRuntimeHealth.status}</strong>
                    {campaignRuntimeHealth.affectedVariants > 0
                      ? ` (${campaignRuntimeHealth.affectedVariants} biến thể bị ảnh hưởng)`
                      : ""}
                  </p>
                ) : null}
              </div>

              {campaignToEdit.status === "DRAFT" || campaignToEdit.status === "SCHEDULED" ? (
                <div className="mt-6 border-t border-black/10 pt-6">
                  <PromotionCampaignForm
                    action={editPromotionAction}
                    initialData={campaignToEdit}
                    mode="edit"
                  />
                </div>
              ) : (
                <div className="mt-6 border-l-2 border-amber-800 bg-amber-50/50 p-4 text-sm leading-6 text-amber-900">
                  <p>
                    Chiến dịch đang ở trạng thái <strong>{STATUS_LABELS[campaignToEdit.status] ?? campaignToEdit.status}</strong>.
                    Theo quy định vòng đời, chiến dịch chỉ có thể chỉnh sửa khi ở trạng thái <strong>Nháp</strong> hoặc <strong>Đã lên lịch</strong>.
                  </p>
                  <p className="mt-2 text-xs">
                    {campaignToEdit.status === "ACTIVE"
                      ? "Nếu muốn thay đổi giá hoặc phạm vi của chiến dịch đang chạy, hãy kết thúc sớm và tạo/sao chép chiến dịch mới."
                      : "Bạn có thể sao chép chiến dịch này thành một bản nháp mới từ bảng danh sách."}
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-red-700">Không tìm thấy chiến dịch yêu cầu chỉnh sửa.</p>
          )}
        </section>
      ) : null}

      <p className="mt-8 text-xs uppercase tracking-[0.14em] text-black/55" aria-live="polite">
        {campaigns.length === 0
          ? "Chưa có chiến dịch nào."
          : `${campaigns.length} chiến dịch (tối đa ${MAX_ADMIN_PROMOTION_PAGE_SIZE} mỗi trang)`}
      </p>

      {campaigns.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-left text-sm">
            <caption className="sr-only">Danh sách chiến dịch khuyến mãi</caption>
            <thead>
              <tr className="border-b border-black/20 text-xs uppercase tracking-[0.14em] text-black/55">
                <th className="py-3 pr-4" scope="col">Tên</th>
                <th className="py-3 pr-4" scope="col">Loại</th>
                <th className="py-3 pr-4" scope="col">Giảm giá</th>
                <th className="py-3 pr-4" scope="col">Thời gian</th>
                <th className="py-3 pr-4" scope="col">Áp dụng</th>
                <th className="py-3 pr-4" scope="col">Trạng thái</th>
                <th className="py-3" scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr className="border-b border-black/10 align-top" key={campaign.id}>
                  <th className="py-4 pr-4 font-medium" scope="row">{campaign.name}</th>
                  <td className="py-4 pr-4">{PROMOTION_CAMPAIGN_KIND_LABELS[campaign.kind]}</td>
                  <td className="py-4 pr-4">{describeDiscount(campaign)}</td>
                  <td className="py-4 pr-4">
                    {campaign.startsAt ? dateTime.format(campaign.startsAt) : "Không giới hạn"}
                    {" → "}
                    {campaign.endsAt ? dateTime.format(campaign.endsAt) : "Không giới hạn"}
                  </td>
                  <td className="py-4 pr-4">{campaign.targetCount}</td>
                  <td className="py-4 pr-4">{STATUS_LABELS[campaign.status] ?? campaign.status}</td>
                  <td className="py-4">
                    <div className="flex flex-wrap gap-2">
                      {/* Rendered from the server-derived lifecycle. The service re-checks every
                          rule regardless, so hiding a button is presentation, not enforcement. */}
                      {campaign.status === "DRAFT" || campaign.status === "SCHEDULED" ? (
                        <Link
                          className={buttonClassName}
                          href={`/admin/promotions?edit=${campaign.id}`}
                        >
                          Sửa
                        </Link>
                      ) : null}
                      {campaign.status === "DRAFT" || campaign.canReEnable ? (
                        <form action={publishPromotionAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">
                            {campaign.canReEnable ? "Bật lại" : "Bật"}
                          </button>
                        </form>
                      ) : null}
                      {campaign.status === "ACTIVE" ? (
                        <form action={endPromotionEarlyAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">Kết thúc sớm</button>
                        </form>
                      ) : null}
                      {campaign.status === "ACTIVE" || campaign.status === "SCHEDULED" ? (
                        <form action={disablePromotionAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">Tắt</button>
                        </form>
                      ) : null}
                      <form action={copyPromotionAction}>
                        <input name="campaignId" type="hidden" value={campaign.id} />
                        <button className={buttonClassName} type="submit">Sao chép</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
