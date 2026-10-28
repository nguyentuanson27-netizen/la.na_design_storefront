"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { describeVoucherAdminReason } from "../../commerce/voucher-admin-feedback";

const inputClass = "mt-2 w-full border border-black/30 bg-transparent px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2";
const buttonClass = "min-h-11 border border-black bg-black px-5 py-2 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-40";

export type VoucherTypeFormInitial = Readonly<{
  id: string;
  name: string;
  priority: number;
  issuance: "AUTO" | "CODE";
  visibility: "PUBLIC" | "PRIVATE";
  code: string | null;
  tierCount: number;
}>;

function Choice({ name, value, label, checked, onChange, disabled }: Readonly<{ name: string; value: string; label: string; checked: boolean; onChange: () => void; disabled?: boolean }>) {
  return <label className="flex min-h-11 items-center gap-3 text-sm">
    <input type="radio" name={name} value={value} checked={checked} onChange={onChange} disabled={disabled} className="h-4 w-4" />{label}
  </label>;
}

/**
 * Voucher types (ADR 0020): a type groups tiers of one kind of offer. A shopper uses at most one tier of each type, and the types
 * are applied in order of `priority`. A CODE type has one code that opens all its tiers.
 */
export function VoucherTypeForm({ initial, action }: Readonly<{
  initial?: VoucherTypeFormInitial | null;
  action: (form: FormData) => Promise<Readonly<{ reason: string; issue?: string }> | undefined | void>;
}>) {
  // With tiers, the distribution is copied into each of them, so it cannot change; the controls are replaced by hidden inputs.
  const locked = (initial?.tierCount ?? 0) > 0;
  const [issuance, setIssuance] = useState<string>(initial?.issuance ?? "AUTO");
  const [visibility, setVisibility] = useState<string>(initial?.visibility ?? "PUBLIC");
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<Readonly<{ reason: string; issue?: string }> | null>(null);
  const refusalNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (refusal) refusalNote.current?.focus(); }, [refusal]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setRefusal(null);
    startTransition(async () => { setRefusal((await action(data)) ?? null); });
  };
  return <form onSubmit={submit} className="mt-8 max-w-3xl space-y-7">
    {refusal ? <p ref={refusalNote} tabIndex={-1} role="alert" className="border-l-2 border-black bg-black/5 p-4 focus-visible:outline-2 focus-visible:outline-offset-2">{describeVoucherAdminReason(refusal.reason, refusal.issue)}</p> : null}
    {initial ? <input type="hidden" name="typeId" value={initial.id} /> : null}
    <p className="border-l-2 border-black pl-4 text-sm leading-6" role="note">
      {"Loại voucher gom các mốc của cùng một kiểu ưu đãi (ví dụ “Giảm theo giá trị đơn”). Mỗi đơn dùng tối đa một mốc của mỗi loại; hệ thống tự chọn mốc cao nhất khách đạt. Nhiều loại có thể dùng cùng lúc, theo thứ tự áp dụng bên dưới."}
    </p>
    <label className="block text-sm font-semibold">{"Tên loại"}
      <input name="name" required maxLength={120} defaultValue={initial?.name ?? ""} className={inputClass} />
    </label>
    <label className="block text-sm font-semibold">{"Thứ tự áp dụng (1–1000, số nhỏ áp dụng trước)"}
      <input name="priority" inputMode="numeric" required pattern="[1-9][0-9]{0,3}" defaultValue={initial?.priority ?? ""} className={inputClass} />
    </label>
    <p className="text-sm text-black/65">{"Loại sau tính mức giảm trên số tiền còn lại sau loại trước (giảm % tính trên phần còn lại). Ngưỡng của mọi mốc vẫn xét trên giá trị đơn trước mọi voucher."}</p>

    {locked && initial ? <>
      <input type="hidden" name="issuance" value={initial.issuance} />
      <input type="hidden" name="visibility" value={initial.visibility} />
    </> : null}
    <fieldset className="border-t border-black/20 pt-5" disabled={locked}>
      <legend className="text-sm font-semibold">{"Cách phát hành"}</legend>
      {locked ? <p className="mt-2 text-sm text-black/65">{"Loại đã có mốc nên cách phát hành và hiển thị không đổi được. Mã chỉ đổi được khi chưa có mốc nào từng được bật."}</p> : null}
      <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Choice name="issuance" value="AUTO" label="Tự động áp dụng" checked={issuance === "AUTO"} onChange={() => { setIssuance("AUTO"); setVisibility("PUBLIC"); }} />
        <Choice name="issuance" value="CODE" label="Khách nhập một mã cho cả loại" checked={issuance === "CODE"} onChange={() => setIssuance("CODE")} />
        <Choice name="visibility" value="PUBLIC" label="Công khai trong danh sách" checked={visibility === "PUBLIC"} onChange={() => setVisibility("PUBLIC")} />
        <Choice name="visibility" value="PRIVATE" label="Riêng tư (chỉ hiện sau khi nhập mã)" checked={visibility === "PRIVATE"} onChange={() => setVisibility("PRIVATE")} disabled={issuance === "AUTO"} />
      </div>
    </fieldset>
    {issuance === "CODE" ? <label className="block text-sm font-semibold">{"Mã của loại (3–32 ký tự A–Z, 0–9, - hoặc _)"}
      <input name="code" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]{3,32}" defaultValue={initial?.code ?? ""} className={inputClass} autoCapitalize="characters" />
    </label> : null}
    <button className={buttonClass} disabled={pending} type="submit">{pending ? "Đang lưu…" : "Lưu loại"}</button>
  </form>;
}
