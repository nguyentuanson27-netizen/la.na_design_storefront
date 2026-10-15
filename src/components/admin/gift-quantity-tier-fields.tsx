"use client";

import { useId, useRef, useState, useTransition } from "react";

import { checkGiftQuantityStackPriorityAction } from "@/app/admin/promotions/gift-quantity/actions";
import {
  MAX_ORDER_SUBTOTAL_THRESHOLD_VND,
  MAX_TIER_UNITS,
  MAX_TIERS_PER_CAMPAIGN,
  priceTier,
  validateTierConfig,
  type QuantityTierConfig,
  type TierConfigIssue,
} from "@/commerce/gift-quantity-tier";
import {
  MAX_STACK_PEERS,
  TIER_STACK_PEER_KINDS,
  type TierRuleInput,
} from "@/commerce/gift-quantity-tier-rule";
import { MAX_STACK_PRIORITY } from "@/commerce/gift-quantity-stack-priority";
import { tiersAfterBasisChange } from "@/components/admin/gift-quantity-tier-basis";

type TierRow = { key: number; min: string; value: string };
type PeerKind = (typeof TIER_STACK_PEER_KINDS)[number];
type PeerRow = { key: number; kind: PeerKind; id: string };
type SampleRow = Readonly<{
  quantity: number;
  tier: string;
  discounted: number;
  discount: number;
  total: number;
  segments: string;
  invalidPrice: boolean;
}>;
/** `unreachable`: ladder thresholds above the engine's cap, which no valid cart can reach or preview. */
type Preview = { ok: false; error: string } | { ok: true; rows: SampleRow[]; unreachable: number[] };

const inputClass = "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const buttonClass = "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";
const labelClass = "text-xs font-semibold uppercase tracking-[0.14em]";
const money = new Intl.NumberFormat("vi-VN");

const issueMessage: Record<TierConfigIssue, string> = {
  TIERS_EMPTY: "Cần ít nhất một bậc để bật chiến dịch.",
  TIERS_TOO_MANY: "Có quá nhiều bậc giảm giá.",
  THRESHOLD_INVALID: "Ngưỡng phải là số nguyên dương.",
  THRESHOLD_NOT_STRICTLY_INCREASING: "Các ngưỡng phải tăng dần, không trùng.",
  VALUE_INVALID: "Mức giảm phải là số nguyên dương; phần trăm từ 1 đến 99.",
  VALUE_DECREASES_WITH_THRESHOLD: "Mức giảm không được thấp hơn bậc trước.",
  SELECTION_PRIORITY_REQUIRED: "Hãy chọn thứ tự giảm khi dùng FROM.",
  SELECTION_PRIORITY_NOT_APPLICABLE: "Thứ tự chỉ áp dụng khi dùng FROM.",
  UNIT_INVALID: "Hãy chọn đơn vị giảm giá phù hợp với cách tính mốc.",
  DISCOUNTED_UNITS_INVALID: "Hãy chọn cách áp dụng giảm giá.",
  BASIS_INVALID: "Cách tính mốc giảm giá không hợp lệ.",
  DISCOUNT_NOT_BELOW_THRESHOLD: "Số tiền giảm cho cả đơn phải nhỏ hơn giá trị đơn hàng tối thiểu của bậc đó.",
};

type Basis = NonNullable<TierRuleInput["basis"]>;

function plainInteger(raw: string, max: number, allowZero = false): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= max && (allowZero || n > 0) ? n : null;
}

/** Illustration only, not a buyer quote. Reuses the exact pure price engine (per-unit VND rounding). */
function calculatePreview(
  basis: Basis,
  tiers: readonly TierRow[],
  unit: TierRuleInput["unit"] | "",
  discountedUnits: TierRuleInput["discountedUnits"] | "",
  priority: TierRuleInput["selectionPriority"] | "",
  priceInput: string,
  extraInput: string,
): Preview {
  const price = plainInteger(priceInput, 2_000_000_000);
  if (price === null) return { ok: false, error: "Giá minh họa phải từ 1 đến 2.000.000.000đ." };
  if (basis === "ORDER_SUBTOTAL") return calculateOrderValuePreview(tiers, unit, price, extraInput);
  if (!unit || !discountedUnits) return { ok: false, error: "Hãy chọn đơn vị và cách áp dụng giảm giá." };

  const ladder: { minQuantity: number; discountValue: number }[] = [];
  for (const row of tiers) {
    if (row.min === "" && row.value === "") continue;
    const minQuantity = plainInteger(row.min, 1_000_000);
    const discountValue = plainInteger(row.value, 2_000_000_000);
    if (minQuantity === null || discountValue === null) {
      return { ok: false, error: "Mỗi bậc phải có ngưỡng và mức giảm là số nguyên dương trong giới hạn." };
    }
    ladder.push({ minQuantity, discountValue });
  }
  ladder.sort((a, b) => a.minQuantity - b.minQuantity);
  const config: QuantityTierConfig = {
    unit,
    discountedUnits,
    selectionPriority: discountedUnits === "FROM_REACHED_THRESHOLD" ? (priority || null) : null,
    tiers: ladder,
  };
  const issues = validateTierConfig(config);
  if (issues.length > 0) return { ok: false, error: issueMessage[issues[0]!] };

  const extra = extraInput === "" ? null : plainInteger(extraInput, MAX_TIER_UNITS);
  if (extraInput !== "" && extra === null) {
    return { ok: false, error: "Chỉ xem trước số lượng từ 1 đến " + MAX_TIER_UNITS + " chiếc." };
  }
  // The engine refuses a cart above MAX_TIER_UNITS, so a step beyond it can neither apply nor be
  // simulated. It is reported, never silently dropped (the server still accepts such a threshold).
  const unreachable = ladder.filter((tier) => tier.minQuantity > MAX_TIER_UNITS).map((tier) => tier.minQuantity);
  // Both sides of every reachable step, plus the EX-19 Q=3 -> Q=4 boundary.
  const quantities = [...new Set([
    3, 4,
    ...(extra === null ? [] : [extra]),
    ...ladder.filter((tier) => tier.minQuantity <= MAX_TIER_UNITS).flatMap((tier) => [tier.minQuantity - 1, tier.minQuantity]),
  ])].filter((q) => q >= 1 && q <= MAX_TIER_UNITS).sort((a, b) => a - b);
  const rows: SampleRow[] = [];
  for (const quantity of quantities) {
    const result = priceTier(config, [{ lineKey: "sample", pancakeVariationId: "sample", quantity, unitPriceVnd: price }]);
    if (result.status === "INVALID_CONFIG" || result.status === "INVALID_INPUT") {
      return { ok: false, error: "Không tính được preview với dữ liệu đã nhập." };
    }
    const invalidPrice = result.status === "TIER_PRICE_INVALID";
    rows.push({
      quantity,
      tier: result.status === "NOT_REACHED" ? "Chưa đạt" : "Từ " + result.winningTier.minQuantity + " chiếc",
      discounted: result.discountedUnitCount,
      discount: result.totalDiscountVnd,
      total: result.segments.reduce((sum, segment) => sum + segment.lineTotalVnd, 0),
      segments: result.segments.map((s) => s.quantity + " × " + money.format(s.unitPriceVnd) + "đ").join(" + "),
      invalidPrice,
    });
  }
  return { ok: true, rows, unreachable };
}

/**
 * Illustration for an order-value ladder: one line, one unit, whose price IS the order value, on both
 * sides of every rung. Same pure engine the shop quotes with; not a buyer quote.
 */
function calculateOrderValuePreview(
  tiers: readonly TierRow[],
  unit: TierRuleInput["unit"] | "",
  extraValue: number,
  extraInput: string,
): Preview {
  if (unit !== "PERCENTAGE" && unit !== "FIXED_AMOUNT_TOTAL_VND") return { ok: false, error: "Hãy chọn đơn vị giảm giá: phần trăm hoặc số tiền cố định cho cả đơn." };
  const ladder: { minQuantity: number; discountValue: number }[] = [];
  for (const row of tiers) {
    if (row.min === "" && row.value === "") continue;
    const minQuantity = plainInteger(row.min, MAX_ORDER_SUBTOTAL_THRESHOLD_VND);
    const discountValue = plainInteger(row.value, 2_000_000_000);
    if (minQuantity === null || discountValue === null) {
      return { ok: false, error: "Mỗi bậc phải có giá trị đơn hàng và mức giảm là số nguyên dương trong giới hạn." };
    }
    ladder.push({ minQuantity, discountValue });
  }
  ladder.sort((a, b) => a.minQuantity - b.minQuantity);
  const config: QuantityTierConfig = { basis: "ORDER_SUBTOTAL", unit, discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: ladder };
  const issues = validateTierConfig(config);
  if (issues.length > 0) return { ok: false, error: issueMessage[issues[0]!] };

  // The "thêm" field is an order value here; blank falls back to the single sample price field.
  const extra = extraInput === "" ? null : plainInteger(extraInput, MAX_ORDER_SUBTOTAL_THRESHOLD_VND);
  if (extraInput !== "" && extra === null) return { ok: false, error: "Giá trị đơn thử phải từ 1 đến 2.000.000.000đ." };
  const values = [...new Set([
    extraValue,
    ...(extra === null ? [] : [extra]),
    ...ladder.flatMap((tier) => [tier.minQuantity - 1, tier.minQuantity]),
  ])].filter((value) => value >= 1 && value <= MAX_ORDER_SUBTOTAL_THRESHOLD_VND).sort((a, b) => a - b);
  const rows: SampleRow[] = [];
  for (const value of values) {
    const result = priceTier(config, [{ lineKey: "sample", pancakeVariationId: "sample", quantity: 1, unitPriceVnd: value }]);
    if (result.status === "INVALID_CONFIG" || result.status === "INVALID_INPUT") {
      return { ok: false, error: "Không tính được preview với dữ liệu đã nhập." };
    }
    rows.push({
      quantity: value,
      tier: result.status === "NOT_REACHED" ? "Chưa đạt" : "Từ " + money.format(result.winningTier.minQuantity) + "đ",
      discounted: result.discountedUnitCount,
      discount: result.totalDiscountVnd,
      total: result.segments.reduce((sum, segment) => sum + segment.lineTotalVnd, 0),
      segments: result.segments.map((segment) => money.format(segment.unitPriceVnd) + "đ").join(" + "),
      invalidPrice: result.status === "TIER_PRICE_INVALID",
    });
  }
  return { ok: true, rows, unreachable: [] };
}

export function GiftQuantityTierFields({
  initialRule,
  campaignId,
  basis,
  onBasisChange,
  basisLocked = false,
}: Readonly<{
  initialRule: TierRuleInput | null;
  campaignId: string | null;
  /** What the thresholds count. Owned by the campaign form, which also owns the scope it implies. */
  basis: Basis;
  onBasisChange: (next: Basis) => void;
  /** A Scheduled campaign cannot change what its stored thresholds mean. */
  basisLocked?: boolean;
}>) {
  const id = useId();
  const byOrderValue = basis === "ORDER_SUBTOTAL";
  const [unit, setUnit] = useState<NonNullable<TierRuleInput["unit"]> | "">(initialRule?.unit ?? "");
  const [discountedUnits, setDiscountedUnits] = useState<NonNullable<TierRuleInput["discountedUnits"]> | "">(initialRule?.discountedUnits ?? "");
  // An order value is discounted as a whole, so the choice is not offered and is always sent as ALL.
  const effectiveDiscountedUnits = byOrderValue ? "ALL_ELIGIBLE_UNITS" : discountedUnits;
  const [selection, setSelection] = useState<NonNullable<TierRuleInput["selectionPriority"]> | "">(initialRule?.selectionPriority ?? "");
  const [tiers, setTiers] = useState<TierRow[]>(() => initialRule?.tiers.length
    ? initialRule.tiers.map((tier, key) => ({ key, min: String(tier.minQuantity), value: String(tier.discountValue) }))
    : [{ key: 0, min: "", value: "" }]);
  const [stacking, setStacking] = useState(initialRule?.stackingEnabled ?? false);
  const [stackPriority, setStackPriority] = useState(initialRule?.stackPriority == null ? "" : String(initialRule.stackPriority));
  const [peers, setPeers] = useState<PeerRow[]>(() => initialRule?.peers.map((peer, key) => ({
    key, kind: peer.kind as PeerKind, id: peer.campaignId,
  })) ?? []);
  const [samplePrice, setSamplePrice] = useState("500000");
  const [extraQuantity, setExtraQuantity] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [priorityNotice, setPriorityNotice] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  // Bumped whenever the priority input changes or a new check starts, so a slow answer for an old
  // value can never be shown against the value the admin has typed since.
  const checkToken = useRef(0);

  function chooseBasis(next: Basis) {
    onBasisChange(next);
    // The two bases do not share a unit that means the same thing, so a stale one is cleared, not carried.
    const unitCleared = (next === "ORDER_SUBTOTAL" && unit === "FIXED_AMOUNT_PER_UNIT_VND") || (next === "QUANTITY" && unit === "FIXED_AMOUNT_TOTAL_VND");
    if (unitCleared) setUnit("");
    // A threshold in pieces is not a threshold in VND: the admin types the rungs again for the new basis.
    setTiers((previous) => tiersAfterBasisChange(previous, basis, next, unitCleared));
    setSelection("");
    setPreview(null);
  }
  function changeTier(key: number, field: "min" | "value", value: string) {
    setTiers((previous) => previous.map((row) => row.key === key ? { ...row, [field]: value } : row));
    setPreview(null);
  }
  function changePeer(key: number, field: "kind" | "id", value: string) {
    setPeers((previous) => previous.map((row) => row.key === key ? { ...row, [field]: value } as PeerRow : row));
  }
  function preflightPriority() {
    const priority = plainInteger(stackPriority, MAX_STACK_PRIORITY, true);
    if (priority === null) { setPriorityNotice("Nhập số nguyên từ 0 đến " + MAX_STACK_PRIORITY + "."); return; }
    setPriorityNotice(null);
    const token = ++checkToken.current;
    startChecking(async () => {
      try {
        const status = await checkGiftQuantityStackPriorityAction(priority, campaignId);
        if (token !== checkToken.current) return;
        setPriorityNotice(status === "CONFLICT"
          ? "Priority này đã có chiến dịch còn hiệu lực sử dụng."
          : status === "AVAILABLE"
            ? "Chưa phát hiện xung đột; máy chủ sẽ kiểm tra lại khi bật chiến dịch."
            : "Không thể kiểm tra mức ưu tiên đã nhập.");
      } catch {
        if (token !== checkToken.current) return;
        setPriorityNotice("Chưa thể kiểm tra; máy chủ vẫn sẽ kiểm tra khi bật chiến dịch.");
      }
    });
  }

  return (
    <fieldset className="min-w-0 border-t border-black/20 pt-6">
      <legend className={labelClass}>{byOrderValue ? "Quy tắc giảm giá theo giá trị đơn hàng" : "Quy tắc giảm giá theo số lượng"}</legend>
      <input name="tierRuleForm" type="hidden" value="on" />
      <p className="mt-2 text-sm leading-6 text-neutral-700">
        Chỉ áp dụng mức giảm của bậc cao nhất đã đạt. Nháp chưa đủ quy tắc vẫn lưu được; khi bật, máy chủ kiểm tra lại tất cả.
      </p>

      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className={labelClass} htmlFor={id + "-basis"}>Mốc tính theo</label>
          {basisLocked ? <input name="tierBasis" type="hidden" value={basis} /> : null}
          <select className={inputClass} disabled={basisLocked} id={id + "-basis"} name={basisLocked ? undefined : "tierBasis"} onChange={(e) => chooseBasis(e.target.value as Basis)} value={basis}>
            <option value="QUANTITY">Số lượng sản phẩm trong giỏ</option>
            <option value="ORDER_SUBTOTAL">Giá trị đơn hàng (toàn bộ giỏ)</option>
          </select>
          <p className="mt-2 text-xs leading-5 text-neutral-700">
            {byOrderValue
              ? "Tính trên số tiền hàng khách phải trả sau Flash Sale và các giảm giá khác, chưa gồm phí vận chuyển và không tính quà 0đ. Luôn áp dụng cho toàn bộ giỏ hàng và chạy sau cùng. Giảm cố định cho cả đơn được chia theo giá từng chiếc, tổng giảm luôn đúng bằng số đã nhập."
              : "Tính trên số chiếc thuộc phạm vi đã chọn."}
          </p>
          {basisLocked ? (
            <p className="mt-2 text-xs text-neutral-700">Chiến dịch đã lên lịch nên không đổi được cách tính mốc. Hãy tắt rồi sao chép thành bản nháp mới nếu cần đổi.</p>
          ) : null}
        </div>
        <div>
          <label className={labelClass} htmlFor={id + "-unit"}>Đơn vị giảm giá</label>
          <select className={inputClass} id={id + "-unit"} name="tierUnit" onChange={(e) => { setUnit(e.target.value as typeof unit); setPreview(null); }} value={unit}>
            <option value="">Chưa chọn</option>
            <option value="PERCENTAGE">Phần trăm (%)</option>
            {byOrderValue
              ? <option value="FIXED_AMOUNT_TOTAL_VND">VND cố định cho cả đơn</option>
              : <option value="FIXED_AMOUNT_PER_UNIT_VND">VND cố định mỗi chiếc</option>}
          </select>
        </div>
        {byOrderValue ? (
          <input name="tierDiscountedUnits" type="hidden" value="ALL_ELIGIBLE_UNITS" />
        ) : (
          <div>
            <label className={labelClass} htmlFor={id + "-units"}>Chiếc được giảm</label>
            <select className={inputClass} id={id + "-units"} name="tierDiscountedUnits" onChange={(e) => {
              const next = e.target.value as typeof discountedUnits;
              setDiscountedUnits(next);
              if (next !== "FROM_REACHED_THRESHOLD") setSelection("");
              setPreview(null);
            }} value={discountedUnits}>
              <option value="">Chưa chọn</option>
              <option value="ALL_ELIGIBLE_UNITS">ALL — mọi chiếc đủ điều kiện</option>
              <option value="FROM_REACHED_THRESHOLD">FROM — từ ngưỡng đầu tiên N0</option>
            </select>
          </div>
        )}
      </div>
      {!byOrderValue && discountedUnits === "FROM_REACHED_THRESHOLD" ? (
        <div className="mt-5">
          <label className={labelClass} htmlFor={id + "-selection"}>Ưu tiên chiếc được giảm</label>
          <select className={inputClass} id={id + "-selection"} name="tierSelectionPriority" onChange={(e) => { setSelection(e.target.value as typeof selection); setPreview(null); }} value={selection}>
            <option value="">Chưa chọn</option>
            <option value="CHEAPEST_FIRST">Giá thấp nhất trước</option>
            <option value="MOST_EXPENSIVE_FIRST">Giá cao nhất trước</option>
          </select>
          <p className="mt-2 text-xs text-neutral-700">
            N0 là ngưỡng nhỏ nhất; khi mua Q chiếc, sẽ giảm Q − N0 + 1 chiếc. Đơn giá làm tròn VND trên từng chiếc trước khi cộng dòng.
          </p>
        </div>
      ) : null}

      <div className="mt-6 space-y-4">
        <h3 className={labelClass}>{byOrderValue ? "Bậc giá trị đơn hàng" : "Bậc số lượng"} ({tiers.length}/{MAX_TIERS_PER_CAMPAIGN})</h3>
        {tiers.map((row, index) => (
          <div className="grid items-end gap-3 border-l-2 border-black/20 pl-4 sm:grid-cols-[1fr_1fr_auto]" key={row.key}>
            <div>
              <label className={labelClass} htmlFor={id + "-min-" + row.key}>Bậc {index + 1}: {byOrderValue ? "từ giá trị đơn (VND)" : "từ số chiếc"}</label>
              <input className={inputClass} id={id + "-min-" + row.key} inputMode="numeric" maxLength={16} name="tierMinQuantity" onChange={(e) => changeTier(row.key, "min", e.target.value)} type="text" value={row.min} />
            </div>
            <div>
              <label className={labelClass} htmlFor={id + "-value-" + row.key}>Mức giảm {unit === "PERCENTAGE" ? "(%)" : byOrderValue ? "(VND cho cả đơn)" : "(VND/chiếc)"}</label>
              <input className={inputClass} id={id + "-value-" + row.key} inputMode="numeric" maxLength={16} name="tierDiscountValue" onChange={(e) => changeTier(row.key, "value", e.target.value)} type="text" value={row.value} />
            </div>
            <button aria-label={"Bỏ bậc " + (index + 1)} className={buttonClass} onClick={() => { setTiers((old) => old.filter((r) => r.key !== row.key)); setPreview(null); }} type="button">Bỏ</button>
          </div>
        ))}
        <button className={buttonClass} disabled={tiers.length >= MAX_TIERS_PER_CAMPAIGN} onClick={() => {
          setTiers((old) => [...old, { key: Math.max(0, ...old.map((r) => r.key + 1)), min: "", value: "" }]);
          setPreview(null);
        }} type="button">+ Thêm bậc</button>
        <p className="text-xs text-neutral-700">
          Tối đa 20 bậc, mỗi ngưỡng khác nhau; mức giảm không được giảm khi lên bậc. % từ 1–99.
          {byOrderValue ? " Giá trị đơn tối đa 2 tỷ; số tiền giảm cho cả đơn phải nhỏ hơn giá trị đơn của chính bậc đó." : " VND tối đa 2 tỷ mỗi chiếc."}
        </p>
      </div>

      <div className="mt-6 border-t border-black/10 pt-6">
        <label className="inline-flex items-center gap-3 text-sm">
          <input checked={stacking} name="stackingEnabled" onChange={(e) => {
            setStacking(e.target.checked);
            if (!e.target.checked) { setStackPriority(""); setPeers([]); }
            checkToken.current += 1;
            setPriorityNotice(null);
          }} type="checkbox" />
          Cho phép cộng dồn khi cả hai chương trình đồng ý
        </label>
        {(stacking || stackPriority !== "" || peers.length > 0) ? (
          <div className="mt-4 space-y-4">
            <div className="max-w-sm">
              <label className={labelClass} htmlFor={id + "-priority"}>Mức ưu tiên (0–{MAX_STACK_PRIORITY}, nhỏ hơn chạy trước)</label>
              <input className={inputClass} id={id + "-priority"} inputMode="numeric" maxLength={10} name="stackPriority" onChange={(e) => { setStackPriority(e.target.value); checkToken.current += 1; setPriorityNotice(null); }} type="text" value={stackPriority} />
              <button className={buttonClass + " mt-3"} disabled={checking} onClick={preflightPriority} type="button">
                {checking ? "Đang kiểm tra…" : "Kiểm tra mức ưu tiên"}
              </button>
              <p aria-live="polite" className="mt-2 text-sm" role="status">{priorityNotice}</p>
            </div>
            <h3 className={labelClass}>Chiến dịch cho phép cộng dồn ({peers.length}/{MAX_STACK_PEERS})</h3>
            {peers.map((peer, index) => (
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" key={peer.key}>
                <div>
                  <label className={labelClass} htmlFor={id + "-peer-kind-" + peer.key}>Đối tác {index + 1}: loại</label>
                  <select className={inputClass} id={id + "-peer-kind-" + peer.key} onChange={(e) => changePeer(peer.key, "kind", e.target.value)} value={peer.kind}>
                    {TIER_STACK_PEER_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor={id + "-peer-id-" + peer.key}>ID chiến dịch hoặc *</label>
                  <input className={inputClass} id={id + "-peer-id-" + peer.key} maxLength={64} onChange={(e) => changePeer(peer.key, "id", e.target.value)} type="text" value={peer.id} />
                </div>
                {peer.id !== "" ? <input name="stackPeer" type="hidden" value={peer.kind + ":" + peer.id} /> : null}
                <button aria-label={"Bỏ đối tác " + (index + 1)} className={buttonClass} onClick={() => setPeers((old) => old.filter((r) => r.key !== peer.key))} type="button">Bỏ</button>
              </div>
            ))}
            <button className={buttonClass} disabled={peers.length >= MAX_STACK_PEERS} onClick={() => {
              setPeers((old) => [...old, { key: Math.max(0, ...old.map((r) => r.key + 1)), kind: "PROMOTION", id: "*" }]);
            }} type="button">+ Thêm chiến dịch</button>
            <p className="text-xs text-neutral-700">
              * = mọi chiến dịch thuộc loại được chọn. ID riêng phải tồn tại; không chọn quà tặng hoặc chính chiến dịch này. Legacy cần đồng ý cộng dồn riêng.
              Kiểm tra priority chỉ là xem trước, không thay quyền kiểm tra khi publish.
            </p>
          </div>
        ) : null}
      </div>

      <section aria-labelledby={id + "-preview"} className="mt-6 border-t border-black/10 pt-6">
        <h3 className={labelClass} id={id + "-preview"}>{byOrderValue ? "Xem trước tiền (hai phía mỗi bậc)" : "Xem trước tiền (EX-19: Q=3 → Q=4)"}</h3>
        <p className="mt-2 text-xs leading-5 text-neutral-700">
          Mô phỏng một loại hàng đồng giá và đủ điều kiện, trước bước tier. Không phải báo giá thực của giỏ;
          scope, ưu đãi trước tier, giá thật và ưu tiên vẫn được máy chủ tính lại.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor={id + "-price"}>{byOrderValue ? "Giá trị đơn hàng thử (VND)" : "Giá mỗi chiếc trước tier (VND)"}</label>
            <input className={inputClass} id={id + "-price"} inputMode="numeric" maxLength={10} onChange={(e) => { setSamplePrice(e.target.value); setPreview(null); }} type="text" value={samplePrice} />
          </div>
          <div>
            <label className={labelClass} htmlFor={id + "-extra"}>{byOrderValue ? "Thử thêm giá trị đơn (tùy chọn)" : "Thử thêm số lượng (tùy chọn)"}</label>
            <input className={inputClass} id={id + "-extra"} inputMode="numeric" maxLength={byOrderValue ? 10 : 5} onChange={(e) => { setExtraQuantity(e.target.value); setPreview(null); }} type="text" value={extraQuantity} />
          </div>
        </div>
        <button className={buttonClass + " mt-4"} onClick={() => setPreview(calculatePreview(basis, tiers, unit, effectiveDiscountedUnits, selection, samplePrice, extraQuantity))} type="button">Xem trước giá</button>
        <div aria-live="polite" className="mt-4 text-sm" role="status">
          {preview === null ? null : !preview.ok ? (
            <p className="text-red-800">{preview.error}</p>
          ) : (
            <div aria-label="Bảng giá minh họa, cuộn ngang được" className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-4" role="region" tabIndex={0}>
              <table className="w-full min-w-[34rem] border-collapse text-left">
                <caption className="sr-only">So sánh số lượng và mức giảm giá minh họa</caption>
                <thead><tr className="border-b border-black/20">
                  <th className="py-2 pr-4" scope="col">{byOrderValue ? "Giá trị đơn" : "Số chiếc"}</th><th className="py-2 pr-4" scope="col">Bậc áp dụng</th>
                  <th className="py-2 pr-4" scope="col">Chiếc giảm</th><th className="py-2 pr-4" scope="col">Tiết kiệm</th>
                  <th className="py-2" scope="col">Tổng sau giảm</th>
                </tr></thead>
                <tbody>{preview.rows.map((row) => (
                  <tr className="border-b border-black/10" key={row.quantity}>
                    <th className="py-3 pr-4" scope="row">{byOrderValue ? money.format(row.quantity) + "đ" : "Q=" + row.quantity}</th><td className="py-3 pr-4">{row.tier}</td>
                    <td className="py-3 pr-4">{row.discounted}</td><td className="py-3 pr-4">{money.format(row.discount)}đ</td>
                    <td className="py-3">{money.format(row.total)}đ</td>
                  </tr>
                ))}
                {preview.unreachable.map((threshold) => (
                  <tr className="border-b border-black/10" key={"unreachable-" + threshold}>
                    <th className="py-3 pr-4" scope="row">Q={money.format(threshold)}</th>
                    <td className="py-3 text-amber-900" colSpan={4}>Không thể xem trước hoặc đạt tới: vượt giới hạn {money.format(MAX_TIER_UNITS)} chiếc.</td>
                  </tr>
                ))}</tbody>
              </table>
              {preview.unreachable.length > 0 ? (
                <p className="mt-3 border-l-2 border-amber-800 pl-3 text-amber-900">
                  Cảnh báo: bậc từ {preview.unreachable.map((threshold) => money.format(threshold)).join(", ")} chiếc vượt giới hạn hiện hành
                  ({money.format(MAX_TIER_UNITS)} chiếc trả tiền mỗi giỏ). Xem trước và báo giá chỉ mô phỏng tới {money.format(MAX_TIER_UNITS)} chiếc,
                  nên không giỏ hợp lệ nào đạt tới bậc này và bậc đó sẽ không bao giờ được áp dụng, dù vẫn có thể lưu hoặc bật.
                </p>
              ) : null}
              {preview.rows.map((row) => (
                <p className={row.invalidPrice ? "mt-2 text-red-800" : "mt-2 text-neutral-700"} key={row.quantity}>
                  {byOrderValue ? money.format(row.quantity) + "đ" : "Q=" + row.quantity}: {row.segments}
                  {row.invalidPrice ? " — TIER_PRICE_INVALID: bỏ toàn bậc, không ép giá về 1đ." : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      </section>
    </fieldset>
  );
}
