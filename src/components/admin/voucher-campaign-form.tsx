"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { ProductPicker, type GiftQuantityProductRef } from "./gift-quantity-campaign-form";
import type { VoucherCampaignRow } from "../../commerce/voucher-campaign";

const inputClass = "mt-2 w-full border border-black/30 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2";
const buttonClass = "min-h-11 border border-black bg-black px-5 py-2 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-40";
const localTime = (date: Date | null | undefined) => (date ? new Date(new Date(date).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16) : "");

function Submit() {
  const { pending } = useFormStatus();
  return <button className={buttonClass} disabled={pending} type="submit">{pending ? "Đang lưu…" : "Lưu voucher"}</button>;
}

function Choice({ name, value, label, checked, onChange, disabled }: Readonly<{ name: string; value: string; label: string; checked: boolean; onChange: () => void; disabled?: boolean }>) {
  return <label className="flex min-h-11 items-center gap-3 text-sm">
    <input type="radio" name={name} value={value} checked={checked} onChange={onChange} disabled={disabled} className="h-4 w-4" />{label}
  </label>;
}

export function VoucherCampaignForm({ initial, categories, included = [], excluded = [], action }: Readonly<{
  initial?: VoucherCampaignRow | null;
  categories: readonly { key: string; label: string; parentKey: string | null }[];
  included?: readonly GiftQuantityProductRef[];
  excluded?: readonly GiftQuantityProductRef[];
  action: (form: FormData) => Promise<void>;
}>) {
  const identityLocked = initial?.enabledAt != null;
  const [kind, setKind] = useState<string>(initial?.kind ?? "MERCHANDISE");
  const [issuance, setIssuance] = useState<string>(initial?.issuance ?? "AUTO");
  const [visibility, setVisibility] = useState<string>(initial?.visibility ?? "PUBLIC");
  const [discountType, setDiscountType] = useState<string>(initial?.discountType ?? "FIXED_AMOUNT_VND");
  const [scopeMode, setScopeMode] = useState<string>(initial?.scopeMode ?? "ALL_SHOP");
  const [includes, setIncludes] = useState(included);
  const [excludes, setExcludes] = useState(excluded);
  const choose = (setter: (value: string) => void, value: string) => () => setter(value);
  return <form action={action} className="mt-8 max-w-3xl space-y-7">
    {initial ? <><input type="hidden" name="campaignId" value={initial.id} /><input type="hidden" name="revision" value={initial.revision} /></> : null}
    <p className="border-l-2 border-black pl-4 text-sm leading-6" role="note">
      {initial?.isEnabled
        ? "Voucher đang bật. Thay đổi chỉ áp dụng cho lượt giữ mới; khách đang giữ ưu đãi (tối đa 10 phút) và đơn đã chốt giữ nguyên."
        : "Lưu không tự bật voucher. Sau khi kiểm tra, chọn Bật trong danh sách."}
    </p>
    <label className="block text-sm font-semibold">{"Tên voucher"}
      <input name="name" required maxLength={120} defaultValue={initial?.name ?? ""} className={inputClass} />
    </label>

    <fieldset className="border-t border-black/20 pt-5" disabled={identityLocked}>
      <legend className="text-sm font-semibold">{"Loại voucher"}</legend>
      {identityLocked ? <p className="mt-2 text-sm text-black/65">{"Đã bật nên loại, cách phát hành, hiển thị và mã không đổi được. Hãy sao chép thành voucher mới."}</p> : null}
      <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Choice name="kind" value="MERCHANDISE" label="Giảm tiền hàng" checked={kind === "MERCHANDISE"} onChange={choose(setKind, "MERCHANDISE")} />
        <Choice name="kind" value="SHIPPING_FREE" label="Miễn phí vận chuyển (100% phí còn lại)" checked={kind === "SHIPPING_FREE"} onChange={choose(setKind, "SHIPPING_FREE")} />
        <Choice name="issuance" value="AUTO" label="Tự động áp dụng" checked={issuance === "AUTO"} onChange={() => { setIssuance("AUTO"); setVisibility("PUBLIC"); }} />
        <Choice name="issuance" value="CODE" label="Khách nhập mã" checked={issuance === "CODE"} onChange={choose(setIssuance, "CODE")} />
        <Choice name="visibility" value="PUBLIC" label="Công khai trong danh sách" checked={visibility === "PUBLIC"} onChange={choose(setVisibility, "PUBLIC")} />
        <Choice name="visibility" value="PRIVATE" label="Riêng tư (chỉ hiện sau khi nhập mã)" checked={visibility === "PRIVATE"} onChange={choose(setVisibility, "PRIVATE")} disabled={issuance === "AUTO"} />
      </div>
      {issuance === "CODE" ? <label className="mt-4 block text-sm font-semibold">{"Mã (3–32 ký tự A–Z, 0–9, - hoặc _)"}
        <input name="code" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]{3,32}" defaultValue={initial?.code ?? ""} className={inputClass} autoCapitalize="characters" />
      </label> : null}
      {visibility === "PRIVATE" && issuance === "CODE" ? <p className="mt-2 text-sm text-black/65">{"Mã riêng tư không phải bí mật bảo mật: ai có mã đều dùng được, vì không giới hạn theo khách."}</p> : null}
    </fieldset>

    {kind === "MERCHANDISE" ? <fieldset className="border-t border-black/20 pt-5">
      <legend className="text-sm font-semibold">{"Mức giảm"}</legend>
      <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Choice name="discountType" value="FIXED_AMOUNT_VND" label="Số tiền cố định" checked={discountType === "FIXED_AMOUNT_VND"} onChange={choose(setDiscountType, "FIXED_AMOUNT_VND")} />
        <Choice name="discountType" value="PERCENTAGE" label="Phần trăm" checked={discountType === "PERCENTAGE"} onChange={choose(setDiscountType, "PERCENTAGE")} />
      </div>
      {discountType === "FIXED_AMOUNT_VND" ? <label className="mt-3 block text-sm font-semibold">{"Số tiền giảm (đồng)"}
        <input name="amountVnd" inputMode="numeric" required pattern="[1-9][0-9]*" defaultValue={initial?.fixedAmountVnd?.toString() ?? ""} className={inputClass} />
      </label> : <div className="mt-3 grid gap-5 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{"Phần trăm giảm (1–99)"}
          <input name="percent" inputMode="numeric" required pattern="[1-9][0-9]?" defaultValue={initial?.percent ?? ""} className={inputClass} />
        </label>
        <label className="block text-sm font-semibold">{"Giảm tối đa (đồng, tuỳ chọn)"}
          <input name="maxDiscountVnd" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={initial?.maxDiscountVnd?.toString() ?? ""} className={inputClass} />
        </label>
      </div>}
    </fieldset> : null}

    <label className="block text-sm font-semibold">{kind === "MERCHANDISE" && discountType === "FIXED_AMOUNT_VND" ? "Giá trị đơn tối thiểu (đồng, bắt buộc và lớn hơn số tiền giảm)" : "Giá trị đơn tối thiểu (đồng, tuỳ chọn)"}
      <input name="minEligibleSubtotalVnd" inputMode="numeric" pattern="[1-9][0-9]*" required={kind === "MERCHANDISE" && discountType === "FIXED_AMOUNT_VND"} defaultValue={initial?.minEligibleSubtotalVnd?.toString() ?? ""} className={inputClass} />
    </label>
    <p className="text-sm text-black/65">{"Tính trên tiền hàng thuộc phạm vi sau khuyến mãi và ưu đãi mua nhiều, trước voucher, chưa gồm phí vận chuyển và quà."}</p>

    <fieldset className="border-t border-black/20 pt-5">
      <legend className="text-sm font-semibold">{"Phạm vi áp dụng"}</legend>
      <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Choice name="scopeMode" value="ALL_SHOP" label="Toàn bộ sản phẩm (có thể loại trừ)" checked={scopeMode === "ALL_SHOP"} onChange={choose(setScopeMode, "ALL_SHOP")} />
        <Choice name="scopeMode" value="TARGETED" label="Theo danh mục / sản phẩm" checked={scopeMode === "TARGETED"} onChange={choose(setScopeMode, "TARGETED")} />
      </div>
      {scopeMode === "TARGETED" ? <>
        <p className="mt-3 text-sm text-black/65">{"Sản phẩm đủ điều kiện nếu thuộc danh mục đã chọn HOẶC được thêm riêng, và không bị loại trừ. Danh mục cha gồm các danh mục con; sản phẩm mới vào danh mục tự được tính."}</p>
        <div className="mt-3 grid gap-x-6 sm:grid-cols-2">{categories.map((category) => <label key={category.key} className={`flex min-h-11 items-center gap-3 text-sm ${category.parentKey ? "pl-5" : "font-semibold"}`}>
          <input type="checkbox" name="categoryKey" value={category.key} defaultChecked={initial?.categoryKeys.includes(category.key)} className="h-4 w-4" />{category.label}
        </label>)}</div>
        <ProductPicker legend={"Thêm sản phẩm riêng"} hint={"Sản phẩm này được tính dù không thuộc danh mục đã chọn."} fieldName="includeProductId" max={500} items={includes} onChange={setIncludes} />
      </> : null}
      <ProductPicker legend={"Loại trừ sản phẩm"} hint={"Loại trừ luôn được ưu tiên hơn danh mục và danh sách thêm riêng."} fieldName="excludeProductId" max={500} items={excludes} onChange={setExcludes} />
    </fieldset>

    <div className="grid gap-5 border-t border-black/20 pt-5 sm:grid-cols-2">
      <label className="block text-sm font-semibold">{"Bắt đầu (giờ Việt Nam)"}
        <input name="startsAt" type="datetime-local" defaultValue={localTime(initial?.startsAt)} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Kết thúc (giờ Việt Nam)"}
        <input name="endsAt" type="datetime-local" defaultValue={localTime(initial?.endsAt)} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Tổng số lượt dùng (tuỳ chọn)"}
        <input name="maxUses" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={initial?.maxUses ?? ""} className={inputClass} />
      </label>
      <label className="block text-sm font-semibold">{"Ngân sách tối đa (đồng, tuỳ chọn)"}
        <input name="maxBudgetVnd" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={initial?.maxBudgetVnd?.toString() ?? ""} className={inputClass} />
      </label>
    </div>
    <p className="text-sm text-black/65">{"Để trống là không giới hạn. Không thể đặt giới hạn thấp hơn số lượt/ngân sách đã dùng và đang được giữ cho khách. Lượt dùng là tổng cho mọi khách, không giới hạn theo từng khách."}</p>
    <Submit />
  </form>;
}
