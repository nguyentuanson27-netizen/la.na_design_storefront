import type { Metadata } from "next";
import Link from "next/link";

import { requireCurrentAdminPage } from "@/auth/current-admin";
import { describeGiftQuantityReason } from "@/commerce/gift-quantity-admin-feedback";
import { createGiftQuantityAdminRepository } from "@/commerce/gift-quantity-admin-repository";
import { isGiftQuantityPromotionsEnabled } from "@/commerce/gift-quantity-gate";
import { CATEGORY_KEYS, categoryByKey } from "@/commerce/category-taxonomy";
import { PromotionAdminStatus } from "@/components/admin/promotion-admin-status";
import { GiftQuantityCampaignForm } from "@/components/admin/gift-quantity-campaign-form";
import { prisma } from "@/db/prisma";

import {
  copyGiftQuantityAction,
  createGiftQuantityAction,
  disableGiftQuantityAction,
  editGiftQuantityAction,
  endGiftQuantityEarlyAction,
  publishGiftQuantityAction,
} from "./actions";

export const metadata: Metadata = { title: "Quà tặng & giảm giá theo số lượng" };

const repository = createGiftQuantityAdminRepository(prisma);

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Nháp",
  SCHEDULED: "Đã lên lịch",
  ACTIVE: "Đang chạy",
  ENDED: "Đã kết thúc",
  DISABLED: "Đã tắt",
};
const KIND_LABELS = { GIFT_ITEM: "Tặng sản phẩm", QUANTITY_TIER: "Giảm giá theo số lượng" } as const;
const SCOPE_LABELS = {
  GLOBAL_ALL_PAID_LINES: "Toàn đơn",
  DYNAMIC_CATEGORY: "Theo danh mục (tự cập nhật)",
  FIXED_PRODUCT_SET: "Danh sách chốt khi bật",
} as const;

const dateTime = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" });

const buttonClassName =
  "min-h-11 border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";

type PageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
    reason?: string | string[];
    code?: string | string[];
    new?: string | string[];
    edit?: string | string[];
  }>;
};

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const categoryOptions = CATEGORY_KEYS.map((key) => {
  const node = categoryByKey(key);
  let depth = 0;
  for (let parent = node?.parentKey ?? null; parent !== null; parent = categoryByKey(parent)?.parentKey ?? null) depth += 1;
  return { key, label: node?.label ?? key, depth };
});

export default async function GiftQuantityAdminPage({ searchParams }: PageProps) {
  await requireCurrentAdminPage();

  const query = await searchParams;
  const search = single(query.q);
  const statusKind = single(query.status);
  const isNew = single(query.new) === "1";
  const editId = single(query.edit);
  const reason = single(query.reason);
  // The URL carries only a typed reason and an allowlisted sub-reason; the sentence is resolved here,
  // on the server, and an unknown or mismatched sub-reason falls back to the reason's generic one.
  const failureMessage = reason === null ? null : describeGiftQuantityReason(reason, single(query.code));
  const now = new Date();

  const campaigns = await repository.listCampaigns({ search, now });
  const toEdit = editId ? await repository.getCampaignForEdit(editId, now) : null;
  // Display only. The gate is enforced by the services; this banner explains why enabling is refused.
  const enabled = isGiftQuantityPromotionsEnabled();

  return (
    <div>
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Quà tặng &amp; giảm giá theo số lượng</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-black/65">
            Chiến dịch tặng sản phẩm và giảm giá theo bậc số lượng do website sở hữu. Phạm vi, điều kiện và giá hiệu
            lực đều do máy chủ quyết định.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link className={`${buttonClassName} inline-flex items-center`} href="/admin/promotions">
            ← Khuyến mãi
          </Link>
          {isNew || editId ? (
            <Link className={`${buttonClassName} inline-flex items-center`} href="/admin/promotions/gift-quantity">
              ← Quay lại danh sách
            </Link>
          ) : (
            <Link className={`${buttonClassName} inline-flex items-center`} href="/admin/promotions/gift-quantity?new=1">
              + Tạo chiến dịch mới
            </Link>
          )}
        </div>
      </header>

      {!enabled ? (
        <p className="mt-8 border-l-2 border-black bg-black/[0.03] px-4 py-3 text-sm leading-6" role="note">
          <strong className="font-semibold">Tính năng đang tắt.</strong> Bạn vẫn có thể soạn nháp, sao chép, tắt và
          kết thúc chiến dịch, nhưng thao tác bật chiến dịch sẽ bị máy chủ từ chối cho đến khi cấu hình triển khai
          được mở.
        </p>
      ) : null}

      <form className="mt-8 flex flex-wrap items-end gap-4" role="search">
        <div className="min-w-64 flex-1">
          <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor="gift-quantity-search">
            Tìm theo tên chiến dịch
          </label>
          <input
            className="mt-2 w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
            defaultValue={search ?? ""}
            id="gift-quantity-search"
            name="q"
            type="search"
          />
        </div>
        <button className={buttonClassName} type="submit">Tìm</button>
      </form>

      <PromotionAdminStatus
        kind={statusKind === "ok" ? "success" : statusKind === "error" ? "error" : null}
        message={
          statusKind === "ok"
            ? "Đã lưu thay đổi."
            : statusKind === "error"
              ? failureMessage ?? "Không thực hiện được thao tác. Hãy tải lại trang và thử lại."
              : null
        }
      />

      {isNew ? (
        <section aria-labelledby="gq-new-heading" className="mt-8 border border-black/20 bg-black/[0.01] p-6">
          <h2 className="text-xl font-semibold tracking-[-0.02em]" id="gq-new-heading">Tạo chiến dịch mới</h2>
          <p className="mt-1 text-xs text-neutral-700">
            Chiến dịch mới ở trạng thái Nháp và không tự kích hoạt. Quy tắc chi tiết được cấu hình ở bước tiếp theo.
          </p>
          <div className="mt-6 border-t border-black/10 pt-6">
            <GiftQuantityCampaignForm action={createGiftQuantityAction} categories={categoryOptions} mode="create" />
          </div>
        </section>
      ) : null}

      {editId ? (
        <section aria-labelledby="gq-edit-heading" className="mt-8 border border-black/20 bg-black/[0.01] p-6">
          {toEdit ? (
            <>
              <h2 className="text-xl font-semibold tracking-[-0.02em]" id="gq-edit-heading">Chỉnh sửa: {toEdit.name}</h2>
              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-neutral-800">
                Trạng thái: <strong>{STATUS_LABELS[toEdit.status] ?? toEdit.status}</strong>
              </p>
              {toEdit.status === "DRAFT" || toEdit.status === "SCHEDULED" ? (
                <div className="mt-6 border-t border-black/10 pt-6">
                  {/* Keyed by campaign: the form and tier fields seed their state from props once, so moving
                      between two ?edit= links on this page must reset all of it, never carry A's rule onto B. */}
                  <GiftQuantityCampaignForm
                    key={toEdit.id}
                    action={editGiftQuantityAction}
                    categories={categoryOptions}
                    initialData={{
                      id: toEdit.id,
                      name: toEdit.name,
                      kind: toEdit.kind,
                      startsAt: toEdit.startsAt,
                      endsAt: toEdit.endsAt,
                      scopeMode: toEdit.scopeMode,
                      giftTrigger: toEdit.giftTrigger,
                      subtotalScope: toEdit.subtotalScope,
                      categoryKeys: toEdit.categoryKeys,
                      includes: toEdit.includes.map((product) => ({ id: product.id, label: product.name })),
                      excludes: toEdit.excludes.map((product) => ({ id: product.id, label: product.name })),
                      status: toEdit.status,
                      frozenAt: toEdit.frozenAt,
                      frozenCount: toEdit.frozenCount,
                      frozenPreview: toEdit.frozenPreview.map((product) => ({ id: product.id, label: product.name })),
                      tierRule: toEdit.tierRule,
                      giftRule: toEdit.giftRule,
                      giftOptions: toEdit.giftOptions,
                    }}
                    mode="edit"
                  />
                </div>
              ) : (
                <p className="mt-6 border-l-2 border-amber-800 bg-amber-50/50 p-4 text-sm leading-6 text-amber-900">
                  Chiến dịch đang ở trạng thái <strong>{STATUS_LABELS[toEdit.status] ?? toEdit.status}</strong>. Chỉ có
                  thể chỉnh sửa khi ở trạng thái Nháp hoặc Đã lên lịch. Bạn có thể sao chép thành một bản nháp mới.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-red-700">Không tìm thấy chiến dịch yêu cầu chỉnh sửa.</p>
          )}
        </section>
      ) : null}

      <p aria-live="polite" className="mt-8 text-xs uppercase tracking-[0.14em] text-black/55">
        {campaigns.length === 0 ? "Chưa có chiến dịch nào." : `${campaigns.length} chiến dịch`}
      </p>

      {campaigns.length > 0 ? (
        <div className="relative mt-6 overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-left text-sm">
            <caption className="sr-only">Danh sách chiến dịch quà tặng và giảm giá theo số lượng</caption>
            <thead>
              <tr className="border-b border-black/20 text-xs uppercase tracking-[0.14em] text-black/55">
                <th className="py-3 pr-4" scope="col">Tên</th>
                <th className="py-3 pr-4" scope="col">Loại</th>
                <th className="py-3 pr-4" scope="col">Phạm vi</th>
                <th className="py-3 pr-4" scope="col">Thời gian</th>
                <th className="py-3 pr-4" scope="col">Trạng thái</th>
                <th className="py-3" scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr className="border-b border-black/10 align-top" key={campaign.id}>
                  <th className="py-4 pr-4 font-medium" scope="row">{campaign.name}</th>
                  <td className="py-4 pr-4">{KIND_LABELS[campaign.kind]}</td>
                  <td className="py-4 pr-4">
                    {SCOPE_LABELS[campaign.scopeMode]}
                    {campaign.scopeMode !== "GLOBAL_ALL_PAID_LINES"
                      ? ` · ${campaign.categoryCount} danh mục, +${campaign.includeCount}/−${campaign.excludeCount} sản phẩm`
                      : ""}
                    {campaign.frozenAt ? ` · chốt ${dateTime.format(campaign.frozenAt)}` : ""}
                  </td>
                  <td className="py-4 pr-4">
                    {campaign.startsAt ? dateTime.format(campaign.startsAt) : "Không giới hạn"}
                    {" → "}
                    {campaign.endsAt ? dateTime.format(campaign.endsAt) : "Không giới hạn"}
                  </td>
                  <td className="py-4 pr-4">{STATUS_LABELS[campaign.status] ?? campaign.status}</td>
                  <td className="py-4">
                    <div className="flex flex-wrap gap-2">
                      {/* Rendered from the server-derived lifecycle. The services re-check every rule,
                          so hiding a button is presentation, not enforcement. */}
                      {campaign.status === "DRAFT" || campaign.status === "SCHEDULED" ? (
                        <Link className={`${buttonClassName} inline-flex items-center`} href={`/admin/promotions/gift-quantity?edit=${campaign.id}`}>
                          Sửa<span className="sr-only"> {campaign.name}</span>
                        </Link>
                      ) : null}
                      {campaign.status === "DRAFT" || campaign.canReEnable ? (
                        <form action={publishGiftQuantityAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">
                            {campaign.canReEnable ? "Bật lại" : "Bật"}<span className="sr-only"> {campaign.name}</span>
                          </button>
                        </form>
                      ) : null}
                      {campaign.status === "ACTIVE" ? (
                        <form action={endGiftQuantityEarlyAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">Kết thúc sớm<span className="sr-only"> {campaign.name}</span></button>
                        </form>
                      ) : null}
                      {campaign.status === "ACTIVE" || campaign.status === "SCHEDULED" ? (
                        <form action={disableGiftQuantityAction}>
                          <input name="campaignId" type="hidden" value={campaign.id} />
                          <button className={buttonClassName} type="submit">Tắt<span className="sr-only"> {campaign.name}</span></button>
                        </form>
                      ) : null}
                      <form action={copyGiftQuantityAction}>
                        <input name="campaignId" type="hidden" value={campaign.id} />
                        <button className={buttonClassName} type="submit">Sao chép<span className="sr-only"> {campaign.name}</span></button>
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
