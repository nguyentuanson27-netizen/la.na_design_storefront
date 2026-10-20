"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { ProductPicker, type GiftQuantityProductRef } from "./gift-quantity-campaign-form";
import type { ShippingCampaignRow } from "../../commerce/shipping-campaign-repository";

const inputClass = "mt-2 w-full border border-black/30 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2";
const buttonClass = "min-h-11 border border-black bg-black px-5 py-2 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-40";
const localTime = (date: Date | null | undefined) => date ? new Date(new Date(date).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16) : "";

function Submit() {
  const { pending } = useFormStatus();
  return <button className={buttonClass} disabled={pending} type="submit">{pending ? "Đang lưu…" : "Lưu chiến dịch"}</button>;
}

export function ShippingCampaignForm({ initial, categories, included = [], excluded = [], action }: Readonly<{
  initial?: ShippingCampaignRow | null;
  categories: readonly { key: string; label: string; parentKey: string | null }[];
  included?: readonly GiftQuantityProductRef[];
  excluded?: readonly GiftQuantityProductRef[];
  action: (form: FormData) => Promise<void>;
}>) {
  const [includes, setIncludes] = useState(included);
  const [excludes, setExcludes] = useState(excluded);
  return <form action={action} className="mt-8 max-w-3xl space-y-7">
    {initial ? <><input type="hidden" name="campaignId" value={initial.id} /><input type="hidden" name="revision" value={initial.revision} /></> : null}
    <p className="border-l-2 border-black pl-4 text-sm leading-6" role="note">
      {initial?.isEnabled
        ? "Chiến dịch đang bật. Thay đổi sẽ áp dụng cho báo giá mới; đơn đã chốt giữ nguyên số tiền."
        : "Lưu không tự bật chiến dịch. Sau khi kiểm tra, chọn Bật trong danh sách để áp dụng theo lịch."}
    </p>
    <label className="block text-sm font-semibold">{"Tên chiến dịch"}
      <input name="name" required maxLength={120} defaultValue={initial?.name ?? ""} className={inputClass} />
    </label>
    <div className="grid gap-5 sm:grid-cols-2">
      <label className="block text-sm font-semibold">{"Số lượng mua tối thiểu"}
        <input name="minimumQuantity" type="number" required min={1} max={10000} step={1} defaultValue={initial?.minimumQuantity ?? ""} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Thứ tự ưu tiên (số nhỏ trước)"}
        <input name="priority" type="number" required min={0} max={1000000} step={1} defaultValue={initial?.priority ?? 0} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Bắt đầu (giờ Việt Nam)"}
        <input name="startsAt" type="datetime-local" defaultValue={localTime(initial?.startsAt)} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Kết thúc (giờ Việt Nam)"}
        <input name="endsAt" type="datetime-local" defaultValue={localTime(initial?.endsAt)} className={inputClass} />
      </label>
    </div>
    <p className="text-sm text-black/65">{"Để trống mốc thời gian nghĩa là không giới hạn mốc đó. Quà tặng không được tính vào số lượng mua."}</p>
    <fieldset className="border-t border-black/20 pt-5">
      <legend className="text-sm font-semibold">{"Danh mục áp dụng"}</legend>
      <p className="mt-2 text-sm text-black/65">{"Chọn danh mục cha bao gồm các danh mục con. Phạm vi này độc lập với các chương trình quà tặng."}</p>
      <div className="mt-3 grid gap-x-6 sm:grid-cols-2">{categories.map((category) => <label key={category.key} className={`flex min-h-11 items-center gap-3 text-sm ${category.parentKey ? "pl-5" : "font-semibold"}`}>
        <input type="checkbox" name="categoryKey" value={category.key} defaultChecked={initial?.categoryKeys.includes(category.key)} className="h-4 w-4" />{category.label}
      </label>)}</div>
    </fieldset>
    <ProductPicker legend={"Thêm sản phẩm riêng"} hint={"Sản phẩm này được tính dù không thuộc danh mục đã chọn."} fieldName="includeProductId" max={500} items={includes} onChange={setIncludes} />
    <ProductPicker legend={"Loại trừ sản phẩm"} hint={"Loại trừ luôn được ưu tiên hơn danh mục và danh sách thêm riêng."} fieldName="excludeProductId" max={500} items={excludes} onChange={setExcludes} />
    <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
      <input type="checkbox" name="stackingEnabled" defaultChecked={initial?.stackingEnabled ?? false} className="mt-1 h-4 w-4" />
      <span>{"Cho phép cộng dồn với giảm giá sản phẩm và quà tặng. Nếu không chọn, giỏ đang nhận các quyền lợi đó sẽ không nhận freeship từ chiến dịch này."}</span>
    </label>
    <Submit />
  </form>;
}
