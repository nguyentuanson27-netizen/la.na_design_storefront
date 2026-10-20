import type { Metadata } from "next";
import Link from "next/link";
import { requireCurrentAdminPage } from "@/auth/current-admin";
import { CATEGORY_KEYS, categoryByKey } from "@/commerce/category-taxonomy";
import { deriveCampaignLifecycle } from "@/commerce/promotion-campaign-lifecycle";
import { createShippingCampaignAdminService } from "@/commerce/shipping-campaign-admin";
import { describeShippingAdminReason } from "@/commerce/shipping-campaign-admin-feedback";
import { ShippingCampaignForm } from "@/components/admin/shipping-campaign-form";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { createShippingCampaignAction, editShippingCampaignAction, enableShippingCampaignAction, disableShippingCampaignAction } from "./actions";

export const metadata: Metadata = { title: "Khuyến mại vận chuyển" };
const PATH = "/admin/promotions/shipping";
const buttonClass = "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-sm font-semibold hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const dateTime = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" });
const statuses: Record<string, string> = { DRAFT: "Nháp", SCHEDULED: "Đã lên lịch", ACTIVE: "Đang chạy", ENDED: "Đã kết thúc", DISABLED: "Đã tắt" };
const single = (value: string | string[] | undefined) => typeof value === "string" ? value : "";

export default async function ShippingCampaignAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireCurrentAdminPage();
  const shopId = readPancakeShopId();
  const service = createShippingCampaignAdminService(prisma, shopId);
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
  return <div>
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-3xl font-semibold tracking-tight">{"Khuyến mại vận chuyển"}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-black/65">{"Không có freeship mặc định theo số lượng hoặc giá trị đơn. Miễn phí vận chuyển chỉ áp dụng khi chiến dịch đang hiệu lực và giỏ đủ điều kiện."}</p>
      </div>
      <div className="flex gap-3"><Link href="/admin/promotions" className={buttonClass}>{"Khuyến mãi"}</Link>
        <Link href={isNew || initial ? PATH : `${PATH}?new=1`} className={buttonClass}>{isNew || initial ? "Danh sách" : "Tạo chiến dịch"}</Link></div>
    </header>
    {reason ? <p role="alert" className="mt-6 border-l-2 border-black bg-black/5 p-4">{describeShippingAdminReason(reason)}</p> : single(query.status) === "ok" ? <p role="status" className="mt-6">{"Đã lưu thay đổi."}</p> : null}
    {editId && !initial ? <p role="alert" className="mt-6">{describeShippingAdminReason("NOT_FOUND")}</p> : null}
    {isNew || initial ? <ShippingCampaignForm key={initial ? `${initial.id}:${initial.revision}` : "new"} initial={initial}
      included={refs(initial?.includeProductIds ?? [])} excluded={refs(initial?.excludeProductIds ?? [])}
      categories={CATEGORY_KEYS.map((key) => categoryByKey(key)!)} action={initial ? editShippingCampaignAction : createShippingCampaignAction} />
      : <section className="mt-8" aria-label={"Danh sách chiến dịch"}>
        {rows.length === 0 ? <p className="py-8 text-black/65">{"Chưa có chiến dịch. Phí vận chuyển cơ bản vẫn áp dụng."}</p> : null}
        {rows.slice(0, 20).map((row) => <article className="flex flex-wrap items-center justify-between gap-4 border-t border-black/20 py-5" key={row.id}>
          <div><h2 className="font-semibold"><Link href={`${PATH}?edit=${encodeURIComponent(row.id)}`} className="underline underline-offset-4">{row.name}</Link></h2>
            <p className="mt-2 text-sm">{statuses[deriveCampaignLifecycle({ ...row, now }).status]}{" · Từ "}{row.minimumQuantity}{" sản phẩm mua trong phạm vi"}</p>
            <p className="mt-1 text-sm text-black/60">{row.startsAt ? dateTime.format(row.startsAt) : "Không giới hạn bắt đầu"}{" → "}{row.endsAt ? dateTime.format(row.endsAt) : "Không giới hạn kết thúc"}</p>
            <p className="mt-1 text-sm text-black/60">{row.stackingEnabled ? "Cho phép cộng dồn" : "Không cộng dồn"}{" · Ưu tiên "}{row.priority}</p>
          </div>
          <form action={row.isEnabled ? disableShippingCampaignAction : enableShippingCampaignAction}>
            <input type="hidden" name="campaignId" value={row.id} /><input type="hidden" name="revision" value={row.revision} />
            <button className={buttonClass} type="submit">{row.isEnabled ? "Tắt" : "Bật"}<span className="sr-only"> {row.name}</span></button>
          </form>
        </article>)}
        {rows.length > 20 ? <Link href={`${PATH}?before=${encodeURIComponent(rows[19]!.id)}`} className={buttonClass}>{"Trang tiếp"}</Link> : null}
      </section>}
  </div>;
}
