"use client";

import { useId, useState, useTransition } from "react";

import { searchGiftQuantityVariantsAction } from "@/app/admin/promotions/gift-quantity/actions";
import { MAX_GIFT_OPTIONS_PER_CAMPAIGN, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP } from "@/commerce/gift-quantity-entitlement";
import type { GiftOptionCandidate, GiftOptionUnavailableReason } from "@/commerce/gift-quantity-gift-options";
import { previewGiftEntitlement, previewSamples, type GiftPreviewRow, type GiftPreviewRule } from "@/commerce/gift-quantity-gift-preview";
import type { GiftRuleInput } from "@/commerce/gift-quantity-gift-rule";

type Trigger = "" | "QUANTITY" | "ORDER_SUBTOTAL";
type AwardMode = "" | "ONCE" | "REPEAT_PER_THRESHOLD";
type Preview = { ok: false; error: string } | { ok: true; rule: GiftPreviewRule; rows: GiftPreviewRow[] };

const inputClass = "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const buttonClass = "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";
const labelClass = "text-xs font-semibold uppercase tracking-[0.14em]";
const money = new Intl.NumberFormat("vi-VN");

const UNAVAILABLE_TEXT: Record<GiftOptionUnavailableReason, string> = {
  INACTIVE: "đã ngừng bán",
  COMPOSITE: "là combo, chưa tặng được",
  NO_STOCK: "hết hàng sẵn sàng",
};

/** Plain base-10 digits only, like the server parser; a hint for the operator, never the authority. */
function plainInteger(raw: string, max: number): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
}

function buildPreview(
  trigger: Exclude<Trigger, "">,
  minimumQuantity: string,
  minimumSubtotal: string,
  awardMode: AwardMode,
  maxPerOrder: string,
  extra: string,
): Preview {
  const quantityTrigger = trigger === "QUANTITY";
  const threshold = quantityTrigger ? plainInteger(minimumQuantity, 1_000_000) : plainInteger(minimumSubtotal, 100_000_000_000);
  if (threshold === null) {
    return { ok: false, error: quantityTrigger ? "Hãy nhập số lượng tối thiểu (số nguyên dương) trước khi xem trước." : "Hãy nhập giá trị đơn hàng tối thiểu (số nguyên dương, đồng) trước khi xem trước." };
  }
  if (!quantityTrigger && awardMode === "") return { ok: false, error: "Hãy chọn cách tặng quà (một lần hoặc lặp lại theo mốc) trước khi xem trước." };
  const cap = maxPerOrder === "" ? null : plainInteger(maxPerOrder, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP);
  if (maxPerOrder !== "" && cap === null) return { ok: false, error: `Số quà tối đa mỗi đơn phải từ 1 đến ${MAX_GIFTS_PER_ORDER_TECHNICAL_CAP}.` };
  const sample = extra === "" ? null : plainInteger(extra, quantityTrigger ? 1_000_000_000 : 1_000_000_000_000);
  if (extra !== "" && sample === null) return { ok: false, error: "Giá trị thử thêm phải là số nguyên dương trong giới hạn." };

  const rule: GiftPreviewRule = {
    trigger,
    minimumQuantity: quantityTrigger ? threshold : null,
    minimumSubtotalVnd: quantityTrigger ? null : threshold,
    awardMode: quantityTrigger ? null : (awardMode as "ONCE" | "REPEAT_PER_THRESHOLD"),
    maxGiftsPerOrder: cap,
  };
  const rows: GiftPreviewRow[] = [];
  for (const value of previewSamples(threshold, sample === null ? [] : [sample])) {
    const row = previewGiftEntitlement(rule, value);
    if (row === null) return { ok: false, error: "Không tính được xem trước với dữ liệu đã nhập." };
    rows.push(row);
  }
  return { ok: true, rule, rows };
}

export function GiftQuantityGiftFields({
  trigger,
  initialRule,
  initialOptions,
}: Readonly<{ trigger: Trigger; initialRule: GiftRuleInput | null; initialOptions: readonly GiftOptionCandidate[] }>) {
  const id = useId();
  const [minimumQuantity, setMinimumQuantity] = useState(initialRule?.minimumQuantity == null ? "" : String(initialRule.minimumQuantity));
  const [minimumSubtotal, setMinimumSubtotal] = useState(initialRule?.minimumSubtotalVnd == null ? "" : String(initialRule.minimumSubtotalVnd));
  const [awardMode, setAwardMode] = useState<AwardMode>(initialRule?.awardMode ?? "");
  const [maxPerOrder, setMaxPerOrder] = useState(initialRule?.maxGiftsPerOrder == null ? "" : String(initialRule.maxGiftsPerOrder));
  const [allowDuplicates, setAllowDuplicates] = useState(initialRule?.allowDuplicateGifts ?? false);
  const [options, setOptions] = useState<readonly GiftOptionCandidate[]>(initialOptions);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly GiftOptionCandidate[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [searching, startSearching] = useTransition();
  const [extra, setExtra] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  const selectedIds = new Set(options.map((option) => option.id));
  const distinctProducts = new Set(options.filter((option) => option.unavailable === null).map((option) => option.productId)).size;

  function search() {
    setFeedback(null);
    startSearching(async () => {
      try {
        const found = await searchGiftQuantityVariantsAction(query);
        setResults(found);
        setFeedback(found.length === 0 ? "Không tìm thấy phiên bản sản phẩm phù hợp." : `Tìm thấy ${found.length} phiên bản.`);
      } catch {
        setResults([]);
        setFeedback("Chưa thể tìm lúc này. Hãy thử lại.");
      }
    });
  }
  function add(candidate: GiftOptionCandidate) {
    if (selectedIds.has(candidate.id)) { setFeedback("Quà này đã có trong danh sách."); return; }
    if (options.length >= MAX_GIFT_OPTIONS_PER_CAMPAIGN) { setFeedback(`Đã đạt giới hạn ${MAX_GIFT_OPTIONS_PER_CAMPAIGN} quà.`); return; }
    setFeedback(`Đã thêm ${candidate.label}.`);
    setOptions((current) => [...current, candidate]);
  }
  function remove(candidate: GiftOptionCandidate) {
    setFeedback(`Đã bỏ ${candidate.label}.`);
    setOptions((current) => current.filter((option) => option.id !== candidate.id));
  }

  return (
    <fieldset className="min-w-0 border-t border-black/20 pt-6">
      <legend className={labelClass}>Mốc nhận quà và danh sách quà</legend>
      <input name="giftRuleForm" type="hidden" value="on" />
      <p className="mt-2 text-sm leading-6 text-neutral-700">
        Nháp chưa đủ thông tin vẫn lưu được; khi bật, máy chủ kiểm tra lại toàn bộ (mốc, quà còn hàng, không phải combo, giới hạn
        số chiến dịch quà cùng lúc).
      </p>

      <div className="mt-5 grid gap-6 md:grid-cols-2">
        {trigger === "" ? (
          <p className="text-sm text-neutral-700" role="note">Hãy chọn điều kiện nhận quà ở trên để nhập mốc.</p>
        ) : null}
        {trigger === "QUANTITY" ? (
          <div>
            <label className={labelClass} htmlFor={id + "-min-qty"}>Số lượng tối thiểu (N)</label>
            <input className={inputClass} id={id + "-min-qty"} inputMode="numeric" maxLength={7} name="giftMinimumQuantity" onChange={(e) => { setMinimumQuantity(e.target.value); setPreview(null); }} type="text" value={minimumQuantity} />
            <p className="mt-1 text-xs text-neutral-700">Mua đủ N sản phẩm trong phạm vi được 1 quà, 2N được 2 quà, và cứ thế.</p>
          </div>
        ) : null}
        {trigger === "ORDER_SUBTOTAL" ? (
          <>
            <div>
              <label className={labelClass} htmlFor={id + "-min-subtotal"}>Giá trị đơn hàng tối thiểu (VND)</label>
              <input className={inputClass} id={id + "-min-subtotal"} inputMode="numeric" maxLength={12} name="giftMinimumSubtotalVnd" onChange={(e) => { setMinimumSubtotal(e.target.value); setPreview(null); }} type="text" value={minimumSubtotal} />
              <p className="mt-1 text-xs text-neutral-700">Tính sau mọi giảm giá; đúng bằng mốc cũng được quà.</p>
            </div>
            <div>
              <label className={labelClass} htmlFor={id + "-award"}>Cách tặng quà</label>
              <select className={inputClass} id={id + "-award"} name="giftAwardMode" onChange={(e) => { setAwardMode(e.target.value as AwardMode); setPreview(null); }} value={awardMode}>
                <option value="">Chưa chọn</option>
                <option value="ONCE">Một lần cho mỗi đơn</option>
                <option value="REPEAT_PER_THRESHOLD">Lặp lại theo mỗi mốc đạt được</option>
              </select>
            </div>
          </>
        ) : null}
        <div>
          <label className={labelClass} htmlFor={id + "-max"}>Số quà tối đa mỗi đơn (tùy chọn)</label>
          <input className={inputClass} id={id + "-max"} inputMode="numeric" maxLength={3} name="giftMaxPerOrder" onChange={(e) => { setMaxPerOrder(e.target.value); setPreview(null); }} type="text" value={maxPerOrder} />
          <p className="mt-1 text-xs text-neutral-700">Từ 1 đến {MAX_GIFTS_PER_ORDER_TECHNICAL_CAP}. Để trống nếu chỉ dùng giới hạn kỹ thuật.</p>
        </div>
      </div>

      <div className="mt-6">
        <label className="inline-flex items-center gap-3 text-sm">
          <input checked={allowDuplicates} name="giftAllowDuplicates" onChange={(e) => { setAllowDuplicates(e.target.checked); setPreview(null); }} type="checkbox" />
          Cho phép tặng trùng quà (nhiều chiếc của cùng một sản phẩm)
        </label>
        <p className="mt-1 text-xs text-neutral-700">
          Khi tắt, mỗi sản phẩm quà chỉ tặng tối đa 1 chiếc mỗi đơn, dù có nhiều phiên bản.
          {!allowDuplicates && options.length > 0 ? ` Với danh sách hiện tại, tối đa ${distinctProducts} quà khác nhau.` : ""}
        </p>
      </div>

      <div className="mt-8 border-t border-black/10 pt-6">
        <h3 className={labelClass}>Danh sách quà ({options.length}/{MAX_GIFT_OPTIONS_PER_CAMPAIGN})</h3>
        <p className="mt-2 text-xs text-neutral-700">
          Chỉ quà còn hàng sẵn sàng, không phải combo và đang bán mới tặng được; khách chọn trong danh sách này.
        </p>
        {options.map((option) => <input key={option.id} name="giftVariantId" type="hidden" value={option.id} />)}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label className={labelClass} htmlFor={id + "-search"}>Tìm quà theo tên, SKU, màu hoặc size</label>
            <input
              className={inputClass}
              id={id + "-search"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
              type="search"
              value={query}
            />
          </div>
          <button className={buttonClass} disabled={searching} onClick={search} type="button">{searching ? "Đang tìm…" : "Tìm quà"}</button>
        </div>
        <p aria-live="polite" className="mt-2 min-h-5 text-xs text-neutral-800" role="status">{feedback}</p>
        {results.length > 0 ? (
          <ul aria-label="Kết quả tìm quà" className="mt-2 space-y-2">
            {results.map((candidate) => {
              const chosen = selectedIds.has(candidate.id);
              return (
                <li className="flex items-center justify-between gap-3 text-sm" key={candidate.id}>
                  <span>
                    {candidate.label} <span className="text-neutral-700">· kho {money.format(candidate.stock)}</span>
                    {candidate.unavailable ? <span className="block text-xs text-amber-900">Không thể chọn: {UNAVAILABLE_TEXT[candidate.unavailable]}.</span> : null}
                  </span>
                  <button className={buttonClass} disabled={chosen || candidate.unavailable !== null} onClick={() => add(candidate)} type="button">
                    {chosen ? "Đã chọn" : "Thêm"}<span className="sr-only"> {candidate.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="mt-4 text-xs uppercase tracking-[0.14em] text-black/55">
          {options.length === 0 ? "Chưa chọn quà nào." : `${options.length} quà đã chọn`}
        </p>
        {options.length > 0 ? (
          <ul aria-label="Quà đã chọn" className="mt-2 space-y-2">
            {options.map((option) => (
              <li className="flex items-center justify-between gap-3 text-sm" key={option.id}>
                <span>
                  {option.label}
                  {option.unavailable ? <span className="block text-xs text-amber-900">Hiện không tặng được: {UNAVAILABLE_TEXT[option.unavailable]}. Máy chủ sẽ từ chối khi bật nếu còn lỗi này.</span> : null}
                </span>
                <button className={buttonClass} onClick={() => remove(option)} type="button">Bỏ<span className="sr-only"> {option.label}</span></button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <section aria-labelledby={id + "-preview"} className="mt-8 border-t border-black/10 pt-6">
        <h3 className={labelClass} id={id + "-preview"}>Xem trước quyền lợi</h3>
        <p className="mt-2 text-xs leading-5 text-neutral-700">
          Mô phỏng một giỏ chỉ gồm sản phẩm trong phạm vi, tính đúng như giỏ hàng. Không phải báo giá thực: phạm vi, giảm giá trước mốc,
          kho và quà khác đang chạy vẫn do máy chủ tính lại.
        </p>
        <div className="mt-4 max-w-sm">
          <label className={labelClass} htmlFor={id + "-extra"}>{trigger === "ORDER_SUBTOTAL" ? "Thử thêm giá trị đơn hàng (VND, tùy chọn)" : "Thử thêm số lượng (tùy chọn)"}</label>
          <input className={inputClass} id={id + "-extra"} inputMode="numeric" maxLength={13} onChange={(e) => { setExtra(e.target.value); setPreview(null); }} type="text" value={extra} />
        </div>
        <button
          className={buttonClass + " mt-4"}
          disabled={trigger === ""}
          onClick={() => { if (trigger !== "") setPreview(buildPreview(trigger, minimumQuantity, minimumSubtotal, awardMode, maxPerOrder, extra)); }}
          type="button"
        >
          Xem trước quyền lợi
        </button>
        <div aria-live="polite" className="mt-4 text-sm" role="status">
          {preview === null ? null : !preview.ok ? (
            <p className="text-red-800">{preview.error}</p>
          ) : (
            <div aria-label="Bảng quyền lợi minh họa, cuộn ngang được" className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-4" role="region" tabIndex={0}>
              <table className="w-full min-w-[28rem] border-collapse text-left">
                <caption className="sr-only">Số quà tặng theo {preview.rule.trigger === "QUANTITY" ? "số lượng" : "giá trị đơn hàng"} minh họa</caption>
                <thead><tr className="border-b border-black/20">
                  <th className="py-2 pr-4" scope="col">{preview.rule.trigger === "QUANTITY" ? "Số chiếc" : "Giá trị đơn"}</th>
                  <th className="py-2 pr-4" scope="col">Đạt</th>
                  <th className="py-2 pr-4" scope="col">Được tặng</th>
                  <th className="py-2" scope="col">Ghi chú</th>
                </tr></thead>
                <tbody>{preview.rows.map((row) => (
                  <tr className="border-b border-black/10" key={row.sample}>
                    <th className="py-3 pr-4" scope="row">{preview.rule.trigger === "QUANTITY" ? `Q=${money.format(row.sample)}` : `${money.format(row.sample)}đ`}</th>
                    <td className="py-3 pr-4">{row.earned}</td>
                    <td className="py-3 pr-4">{row.entitled}</td>
                    <td className="py-3">
                      {row.cappedByMaximum ? "Đã chạm giới hạn quà mỗi đơn." : row.shortfallToNext === null ? "Không còn quà kế tiếp." : `Còn thiếu ${money.format(row.shortfallToNext)}${preview.rule.trigger === "QUANTITY" ? " chiếc" : "đ"} để thêm 1 quà.`}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
              {!allowDuplicates && options.length > 0 ? (
                <p className="mt-2 text-neutral-700">Không cho tặng trùng: tối đa {distinctProducts} quà khác nhau mỗi đơn, dù số quà được hưởng cao hơn.</p>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </fieldset>
  );
}
