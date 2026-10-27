import type { Metadata } from "next";
import Link from "next/link";
import { requireCurrentAdminPage } from "@/auth/current-admin";
import { CATEGORY_KEYS, categoryByKey } from "@/commerce/category-taxonomy";
import { deriveCampaignLifecycle } from "@/commerce/promotion-campaign-lifecycle";
import { describeVoucherAdminReason } from "@/commerce/voucher-admin-feedback";
import { createVoucherAdminService } from "@/commerce/voucher-admin-service";
import { voucherCapFloor } from "@/commerce/voucher-campaign";
import { isVoucherEnabled } from "@/commerce/voucher-gate";
import { VoucherCampaignForm } from "@/components/admin/voucher-campaign-form";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { copyVoucherAction, createVoucherAction, disableVoucherAction, editVoucherAction, enableVoucherAction } from "./actions";

export const metadata: Metadata = { title: "Voucher" };
const PATH = "/admin/promotions/vouchers";
const buttonClass = "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-sm font-semibold hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const dateTime = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" });
const money = new Intl.NumberFormat("vi-VN");
const statuses: Record<string, string> = { DRAFT: "Nháp", SCHEDULED: "Đã lên lịch", ACTIVE: "Đang chạy", ENDED: "Đã kết thúc", DISABLED: "Đã tắt" };
const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

function describeRule(row: { kind: string; discountType: string | null; fixedAmountVnd: bigint | null; percent: number | null; maxDiscountVnd: bigint | null; minEligibleSubtotalVnd: bigint | null }): string {
  const min = row.minEligibleSubtotalVnd === null ? "" : ` · Đơn từ ${money.format(Number(row.minEligibleSubtotalVnd))}đ`;
  if (row.kind === "SHIPPING_FREE") return `Miễn phí vận chuyển${min}`;
  if (row.discountType === "FIXED_AMOUNT_VND") return `Giảm ${money.format(Number(row.fixedAmountVnd))}đ${min}`;
  return `Giảm ${row.percent}%${row.maxDiscountVnd === null ? "" : ` (tối đa ${money.format(Number(row.maxDiscountVnd))}đ)`}${min}`;
}

export default async function VoucherAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireCurrentAdminPage();
  const shopId = readPancakeShopId();
  const service = createVoucherAdminService(prisma, shopId);
  const query = await searchParams;
  const editId = single(query.edit);
  const isNew = single(query.new) === "1";
  const cursor = single(query.before);
  const rows = await service.list(session, /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? cursor : undefined);
  const initial = editId ? await service.get(session, editId) : null;
  const ids = initial ? [...new Set([...initial.includeProductIds, ...initial.excludeProductIds])] : [];
  const products = ids.length ? await prisma.productMirror.findMany({ where: { id: { in: ids }, pancakeShopId: shopId }, select: { id: true, name: true } }) : [];
  const labels = new Map(products.map((product) => [product.id, product.name]));
  const refs = (values: readonly string[]) => values.map((id) => ({ id, label: labels.get(id) ?? id }));
  const reason = single(query.reason);
  const now = new Date();
  const enabled = isVoucherEnabled();
  return <div>
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-3xl font-semibold tracking-tight">{"Voucher"}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-black/65">{"Mỗi đơn dùng tối đa một voucher giảm tiền hàng và một voucher miễn phí vận chuyển. Voucher cộng dồn sau khuyến mãi và ưu đãi mua nhiều; hệ thống mặc định chọn tổ hợp có tổng thanh toán thấp nhất."}</p>
      </div>
      <div className="flex gap-3"><Link href="/admin/promotions" className={buttonClass}>{"Khuyến mãi"}</Link>
        <Link href={isNew || initial ? PATH : `${PATH}?new=1`} className={buttonClass}>{isNew || initial ? "Danh sách" : "Tạo voucher"}</Link></div>
    </header>
    {enabled ? null : <p role="note" className="mt-6 border-l-2 border-black bg-black/5 p-4 text-sm leading-6">{"Tính năng voucher đang TẮT trên máy chủ (LA_VOUCHER_ENABLED). Bạn có thể soạn và kiểm tra voucher, nhưng khách chưa thấy và chưa dùng được voucher nào."}</p>}
    {reason ? <p role="alert" className="mt-6 border-l-2 border-black bg-black/5 p-4">{describeVoucherAdminReason(reason, single(query.issue) || undefined)}</p> : single(query.status) === "ok" ? <p role="status" className="mt-6">{"Đã lưu thay đổi."}</p> : null}
    {editId && !initial ? <p role="alert" className="mt-6">{describeVoucherAdminReason("NOT_FOUND")}</p> : null}
    {isNew || initial ? <VoucherCampaignForm key={initial ? `${initial.id}:${initial.revision}` : "new"} initial={initial}
      included={refs(initial?.includeProductIds ?? [])} excluded={refs(initial?.excludeProductIds ?? [])}
      categories={CATEGORY_KEYS.map((key) => categoryByKey(key)!)} action={initial ? editVoucherAction : createVoucherAction} />
      : <section className="mt-8" aria-label={"Danh sách voucher"}>
        {rows.length === 0 ? <p className="py-8 text-black/65">{"Chưa có voucher."}</p> : null}
        {rows.slice(0, 20).map((row) => {
          const lifecycle = deriveCampaignLifecycle({ ...row, now });
          const floor = voucherCapFloor({ redeemedUses: row.redeemedUses, reservedUses: row.reservedUses, redeemedVnd: Number(row.redeemedVnd), reservedVnd: Number(row.reservedVnd) });
          return <article className="flex flex-wrap items-center justify-between gap-4 border-t border-black/20 py-5" key={row.id}>
            <div><h2 className="font-semibold"><Link href={`${PATH}?edit=${encodeURIComponent(row.id)}`} className="underline underline-offset-4">{row.name}</Link></h2>
              <p className="mt-2 text-sm">{statuses[lifecycle.status]}{" · "}{describeRule(row)}</p>
              <p className="mt-1 text-sm text-black/60">{row.issuance === "CODE" ? `Mã ${row.code} · ${row.visibility === "PRIVATE" ? "Riêng tư" : "Công khai"}` : "Tự động · Công khai"}{" · "}{row.scopeMode === "ALL_SHOP" ? "Toàn bộ sản phẩm" : "Theo danh mục/sản phẩm"}</p>
              <p className="mt-1 text-sm text-black/60">{row.startsAt ? dateTime.format(row.startsAt) : "Không giới hạn bắt đầu"}{" → "}{row.endsAt ? dateTime.format(row.endsAt) : "Không giới hạn kết thúc"}</p>
              <p className="mt-1 text-sm text-black/60">{"Đã dùng "}{row.redeemedUses}{" · đang giữ "}{row.reservedUses}{row.maxUses === null ? " · không giới hạn lượt" : ` · tối đa ${row.maxUses} lượt`}{" · ngân sách đã cam kết "}{money.format(floor.vnd)}{"đ"}{row.maxBudgetVnd === null ? "" : ` / ${money.format(Number(row.maxBudgetVnd))}đ`}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <form action={row.isEnabled ? disableVoucherAction : enableVoucherAction}>
                <input type="hidden" name="campaignId" value={row.id} /><input type="hidden" name="revision" value={row.revision} />
                <button className={buttonClass} type="submit">{row.isEnabled ? "Tắt" : "Bật"}<span className="sr-only"> {row.name}</span></button>
              </form>
              <form action={copyVoucherAction} className="flex items-center gap-2">
                <input type="hidden" name="campaignId" value={row.id} /><input type="hidden" name="revision" value={row.revision} />
                {row.issuance === "CODE" ? <label className="sr-only" htmlFor={`copy-code-${row.id}`}>{"Mã mới cho bản sao "}{row.name}</label> : null}
                {row.issuance === "CODE" ? <input id={`copy-code-${row.id}`} name="code" placeholder="Mã mới" required minLength={3} maxLength={32} className="min-h-11 w-32 border border-black/30 bg-transparent px-3 text-sm" /> : null}
                <button className={buttonClass} type="submit">{"Sao chép"}<span className="sr-only"> {row.name}</span></button>
              </form>
            </div>
          </article>;
        })}
        {rows.length > 20 ? <Link href={`${PATH}?before=${encodeURIComponent(rows[19]!.id)}`} className={buttonClass}>{"Trang tiếp"}</Link> : null}
      </section>}
  </div>;
}
