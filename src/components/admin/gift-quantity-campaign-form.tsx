"use client";

import { useId, useState, useTransition } from "react";

import {
  previewGiftQuantityScopeAction,
  searchGiftQuantityProductsAction,
} from "@/app/admin/promotions/gift-quantity/actions";
import type { AdminScopePreview } from "@/commerce/gift-quantity-admin-repository";
import {
  MAX_SCOPE_EXCLUDED_PRODUCTS,
  MAX_SCOPE_INCLUDED_PRODUCTS,
} from "@/commerce/gift-quantity-scope";

export type GiftQuantityCategoryOption = Readonly<{ key: string; label: string; depth: number }>;
export type GiftQuantityProductRef = Readonly<{ id: string; label: string }>;

export type GiftQuantityCampaignFormProps = Readonly<{
  mode: "create" | "edit";
  categories: readonly GiftQuantityCategoryOption[];
  initialData?: Readonly<{
    id: string;
    name: string;
    kind: "GIFT_ITEM" | "QUANTITY_TIER";
    startsAt: Date | null;
    endsAt: Date | null;
    scopeMode: "GLOBAL_ALL_PAID_LINES" | "DYNAMIC_CATEGORY" | "FIXED_PRODUCT_SET";
    giftTrigger: "QUANTITY" | "ORDER_SUBTOTAL" | null;
    subtotalScope: "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES" | null;
    categoryKeys: readonly string[];
    includes: readonly GiftQuantityProductRef[];
    excludes: readonly GiftQuantityProductRef[];
    status: string;
    frozenAt: Date | null;
    frozenCount: number;
    frozenPreview: readonly GiftQuantityProductRef[];
  }>;
  action: (formData: FormData) => void | Promise<void>;
}>;

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none transition-colors placeholder:text-neutral-500 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const selectClassName = inputClassName;
const buttonClassName =
  "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";
const primaryButtonClassName =
  "inline-flex min-h-11 items-center justify-center border border-black bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";
const labelClassName = "text-xs font-semibold uppercase tracking-[0.14em]";

function toVietnamLocal(date: Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const v = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}T${p(v.getUTCHours())}:${p(v.getUTCMinutes())}`;
}

function ProductPicker({
  legend,
  hint,
  fieldName,
  max,
  items,
  onChange,
}: Readonly<{
  legend: string;
  hint: string;
  fieldName: "includeProductId" | "excludeProductId";
  max: number;
  items: readonly GiftQuantityProductRef[];
  onChange: (next: readonly GiftQuantityProductRef[]) => void;
}>) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly GiftQuantityProductRef[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [searching, startSearching] = useTransition();

  function search() {
    setFeedback(null);
    startSearching(async () => {
      const found = await searchGiftQuantityProductsAction(query);
      setResults(found);
      if (found.length === 0) setFeedback("Không tìm thấy sản phẩm phù hợp.");
    });
  }
  function add(item: GiftQuantityProductRef) {
    if (items.some((entry) => entry.id === item.id)) {
      setFeedback("Sản phẩm này đã có trong danh sách.");
      return;
    }
    if (items.length >= max) {
      setFeedback(`Đã đạt giới hạn ${max} sản phẩm.`);
      return;
    }
    setFeedback(null);
    onChange([...items, item]);
  }

  return (
    <fieldset className="border-t border-black/20 pt-6">
      <legend className={labelClassName}>{legend}</legend>
      <p className="mt-2 text-xs text-neutral-700" id={`${id}-hint`}>{hint}</p>
      {items.map((item) => (
        <input key={item.id} name={fieldName} type="hidden" value={item.id} />
      ))}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className={labelClassName} htmlFor={`${id}-search`}>Tìm sản phẩm</label>
          <input
            aria-describedby={`${id}-hint`}
            className={inputClassName}
            id={`${id}-search`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                search();
              }
            }}
            type="search"
            value={query}
          />
        </div>
        <button className={buttonClassName} disabled={searching} onClick={search} type="button">
          {searching ? "Đang tìm…" : "Tìm"}
        </button>
      </div>
      <p aria-live="polite" className="mt-2 min-h-5 text-xs text-neutral-800" role="status">{feedback}</p>
      {results.length > 0 ? (
        <ul aria-label="Kết quả tìm kiếm sản phẩm" className="mt-2 space-y-1">
          {results.map((item) => (
            <li className="flex items-center justify-between gap-3 text-sm" key={item.id}>
              <span>{item.label}</span>
              <button className={buttonClassName} onClick={() => add(item)} type="button">
                Thêm<span className="sr-only"> {item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-4 text-xs uppercase tracking-[0.14em] text-black/55">
        {items.length === 0 ? "Chưa chọn sản phẩm nào." : `${items.length} sản phẩm đã chọn`}
      </p>
      {items.length > 0 ? (
        <ul aria-label={legend} className="mt-2 space-y-1">
          {items.map((item) => (
            <li className="flex items-center justify-between gap-3 text-sm" key={item.id}>
              <span>{item.label}</span>
              <button
                className={buttonClassName}
                onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
                type="button"
              >
                Bỏ<span className="sr-only"> {item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

export function GiftQuantityCampaignForm({ mode, categories, initialData, action }: GiftQuantityCampaignFormProps) {
  const formId = useId();
  const [kind, setKind] = useState<"GIFT_ITEM" | "QUANTITY_TIER">(initialData?.kind ?? "GIFT_ITEM");
  const [giftTrigger, setGiftTrigger] = useState<"" | "QUANTITY" | "ORDER_SUBTOTAL">(initialData?.giftTrigger ?? "");
  const [subtotalScope, setSubtotalScope] = useState<"" | "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES">(initialData?.subtotalScope ?? "");
  const [scopeMode, setScopeMode] = useState<"GLOBAL_ALL_PAID_LINES" | "DYNAMIC_CATEGORY" | "FIXED_PRODUCT_SET">(
    initialData?.scopeMode ?? "DYNAMIC_CATEGORY",
  );
  const [categoryKeys, setCategoryKeys] = useState<readonly string[]>(initialData?.categoryKeys ?? []);
  const [includes, setIncludes] = useState<readonly GiftQuantityProductRef[]>(initialData?.includes ?? []);
  const [excludes, setExcludes] = useState<readonly GiftQuantityProductRef[]>(initialData?.excludes ?? []);
  const [preview, setPreview] = useState<AdminScopePreview | null>(null);
  const [previewing, startPreviewing] = useTransition();

  const isGift = kind === "GIFT_ITEM";
  // Once Scheduled, the trigger decides what the stored thresholds mean, so it is shown but fixed.
  const locked = mode === "edit" && initialData?.status === "SCHEDULED";
  // The global scope is the answer to exactly one question: gift value of the whole order.
  const globalAllowed = isGift && giftTrigger === "ORDER_SUBTOTAL" && subtotalScope === "ALL_PAID_LINES";
  const isGlobal = scopeMode === "GLOBAL_ALL_PAID_LINES";

  function chooseSubtotalScope(next: "" | "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES") {
    setSubtotalScope(next);
    setPreview(null);
    // ALL_PAID_LINES is the global scope and ELIGIBLE_PAID_LINES never is: keep the two in step so
    // the form cannot submit the contradiction the server would refuse.
    if (next === "ALL_PAID_LINES") setScopeMode("GLOBAL_ALL_PAID_LINES");
    else if (isGlobal) setScopeMode("DYNAMIC_CATEGORY");
  }
  function chooseTrigger(next: "" | "QUANTITY" | "ORDER_SUBTOTAL") {
    setGiftTrigger(next);
    setPreview(null);
    if (next !== "ORDER_SUBTOTAL") {
      setSubtotalScope("");
      if (isGlobal) setScopeMode("DYNAMIC_CATEGORY");
    }
  }
  function runPreview() {
    startPreviewing(async () => {
      setPreview(
        await previewGiftQuantityScopeAction({
          scopeMode,
          categoryKeys: [...categoryKeys],
          includeProductIds: includes.map((item) => item.id),
          excludeProductIds: excludes.map((item) => item.id),
          global: globalAllowed,
        }),
      );
    });
  }

  return (
    <form action={action} className="space-y-8">
      {mode === "edit" && initialData ? <input name="campaignId" type="hidden" value={initialData.id} /> : null}
      <input name="scopeMode" type="hidden" value={scopeMode} />

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <label className={labelClassName} htmlFor={`${formId}-name`}>
            Tên chiến dịch <span aria-hidden="true">*</span>
          </label>
          <input
            className={inputClassName}
            defaultValue={initialData?.name ?? ""}
            id={`${formId}-name`}
            maxLength={120}
            name="name"
            required
            type="text"
          />
          <p className="mt-1 text-xs text-neutral-700">Tối đa 120 ký tự.</p>
        </div>
        <div>
          <label className={labelClassName} htmlFor={`${formId}-kind`}>
            Loại chiến dịch <span aria-hidden="true">*</span>
          </label>
          {mode === "edit" ? (
            <>
              <input name="kind" type="hidden" value={kind} />
              <p className="py-2 text-base" id={`${formId}-kind`}>
                {isGift ? "Tặng sản phẩm" : "Giảm giá theo số lượng"}
              </p>
              <p className="text-xs text-neutral-700">Không thể đổi loại sau khi đã tạo.</p>
            </>
          ) : (
            <select
              className={selectClassName}
              id={`${formId}-kind`}
              name="kind"
              onChange={(event) => {
                setKind(event.target.value as "GIFT_ITEM" | "QUANTITY_TIER");
                setGiftTrigger("");
                setSubtotalScope("");
                if (isGlobal) setScopeMode("DYNAMIC_CATEGORY");
                setPreview(null);
              }}
              value={kind}
            >
              <option value="GIFT_ITEM">Tặng sản phẩm (theo số lượng hoặc giá trị đơn)</option>
              <option value="QUANTITY_TIER">Giảm giá theo bậc số lượng</option>
            </select>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <label className={labelClassName} htmlFor={`${formId}-starts`}>Bắt đầu (giờ Việt Nam)</label>
          <input className={inputClassName} defaultValue={toVietnamLocal(initialData?.startsAt)} id={`${formId}-starts`} name="startsAt" type="datetime-local" />
        </div>
        <div>
          <label className={labelClassName} htmlFor={`${formId}-ends`}>Kết thúc (giờ Việt Nam)</label>
          <input className={inputClassName} defaultValue={toVietnamLocal(initialData?.endsAt)} id={`${formId}-ends`} name="endsAt" type="datetime-local" />
        </div>
      </div>

      {isGift ? (
        <fieldset className="border-t border-black/20 pt-6">
          <legend className={labelClassName}>Điều kiện nhận quà</legend>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div>
              <label className={labelClassName} htmlFor={`${formId}-trigger`}>Nhận quà khi</label>
              {locked ? <input name="giftTrigger" type="hidden" value={giftTrigger} /> : null}
              <select className={selectClassName} disabled={locked} id={`${formId}-trigger`} name={locked ? undefined : "giftTrigger"} onChange={(event) => chooseTrigger(event.target.value as "" | "QUANTITY" | "ORDER_SUBTOTAL")} value={giftTrigger}>
                <option value="">Chưa chọn</option>
                <option value="QUANTITY">Mua đủ số lượng</option>
                <option value="ORDER_SUBTOTAL">Đơn hàng đạt giá trị tối thiểu</option>
              </select>
            </div>
            {giftTrigger === "ORDER_SUBTOTAL" ? (
              <div>
                <label className={labelClassName} htmlFor={`${formId}-subtotal-scope`}>Giá trị đơn hàng tính trên</label>
                {locked ? <input name="subtotalScope" type="hidden" value={subtotalScope} /> : null}
                <select className={selectClassName} disabled={locked} id={`${formId}-subtotal-scope`} name={locked ? undefined : "subtotalScope"} onChange={(event) => chooseSubtotalScope(event.target.value as "" | "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES")} value={subtotalScope}>
                  <option value="">Chưa chọn</option>
                  <option value="ALL_PAID_LINES">Tất cả sản phẩm trả tiền trong đơn</option>
                  <option value="ELIGIBLE_PAID_LINES">Chỉ sản phẩm thuộc phạm vi đã chọn</option>
                </select>
              </div>
            ) : null}
          </div>
          {locked ? (
            <p className="mt-3 text-xs text-neutral-700" id={`${formId}-locked-note`}>
              Chiến dịch đã lên lịch nên không đổi được điều kiện nhận quà. Hãy tắt rồi sao chép thành bản nháp mới nếu cần đổi.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-neutral-700">
            Số lượng/giá trị tối thiểu, số suất tối đa và danh sách quà được cấu hình ở bước quy tắc.
          </p>
        </fieldset>
      ) : null}

      <fieldset className="border-t border-black/20 pt-6">
        <legend className={labelClassName}>Phạm vi áp dụng</legend>
        {globalAllowed ? (
          <p className="mt-3 border-l-2 border-black bg-black/[0.03] px-4 py-3 text-sm" id={`${formId}-global`} role="note">
            <strong>Áp dụng giá trị toàn đơn.</strong> Tính trên tất cả sản phẩm trả tiền, không cần chọn danh mục
            hay sản phẩm.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-6" role="radiogroup" aria-label="Kiểu danh sách sản phẩm">
              <label className="inline-flex items-center gap-2 text-sm">
                <input checked={scopeMode === "DYNAMIC_CATEGORY"} name="scopeModeChoice" onChange={() => { setScopeMode("DYNAMIC_CATEGORY"); setPreview(null); }} type="radio" value="DYNAMIC_CATEGORY" />
                <span>Theo danh mục hiện tại (tự cập nhật khi danh mục thay đổi)</span>
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input checked={scopeMode === "FIXED_PRODUCT_SET"} name="scopeModeChoice" onChange={() => { setScopeMode("FIXED_PRODUCT_SET"); setPreview(null); }} type="radio" value="FIXED_PRODUCT_SET" />
                <span>Chốt danh sách sản phẩm khi bật chiến dịch</span>
              </label>
            </div>
            {scopeMode === "FIXED_PRODUCT_SET" ? (
              <p className="mt-2 text-xs text-neutral-700">
                Danh sách được chốt tại thời điểm bấm Bật (kể cả khi chiến dịch bắt đầu sau). Sản phẩm thêm vào danh
                mục sau đó sẽ không tự tham gia.
              </p>
            ) : null}

            <fieldset className="mt-6">
              <legend className={labelClassName}>Danh mục áp dụng</legend>
              <p className="mt-2 text-xs text-neutral-700">Chọn danh mục cha sẽ bao gồm cả các danh mục con, giống trang danh mục.</p>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {categories.map((category) => (
                  <li key={category.key} style={{ paddingLeft: `${category.depth * 1.25}rem` }}>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        checked={categoryKeys.includes(category.key)}
                        name="categoryKey"
                        onChange={(event) => {
                          setPreview(null);
                          setCategoryKeys((current) =>
                            event.target.checked ? [...current, category.key] : current.filter((key) => key !== category.key),
                          );
                        }}
                        type="checkbox"
                        value={category.key}
                      />
                      <span>{category.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <div className="mt-6 space-y-6">
              <ProductPicker
                fieldName="includeProductId"
                hint="Sản phẩm thêm riêng, kể cả khi không thuộc danh mục đã chọn."
                items={includes}
                legend="Sản phẩm áp dụng thêm"
                max={MAX_SCOPE_INCLUDED_PRODUCTS}
                onChange={(next) => { setIncludes(next); setPreview(null); }}
              />
              <ProductPicker
                fieldName="excludeProductId"
                hint="Loại trừ luôn được ưu tiên hơn mọi lựa chọn áp dụng."
                items={excludes}
                legend="Sản phẩm loại trừ"
                max={MAX_SCOPE_EXCLUDED_PRODUCTS}
                onChange={(next) => { setExcludes(next); setPreview(null); }}
              />
            </div>
          </>
        )}
      </fieldset>

      <section aria-labelledby={`${formId}-preview-heading`} className="border-t border-black/20 pt-6">
        <h3 className={labelClassName} id={`${formId}-preview-heading`}>Xem trước phạm vi</h3>
        {initialData && initialData.scopeMode === "FIXED_PRODUCT_SET" && initialData.frozenAt ? (
          <p className="mt-2 text-sm">
            Danh sách đã chốt lúc {new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(initialData.frozenAt)}
            : <strong>{initialData.frozenCount}</strong> sản phẩm
            {initialData.frozenPreview.length > 0 ? ` (${initialData.frozenPreview.map((item) => item.label).join(", ")}${initialData.frozenCount > initialData.frozenPreview.length ? ", …" : ""})` : ""}.
          </p>
        ) : null}
        <div className="mt-3">
          <button className={buttonClassName} disabled={previewing || isGlobal} onClick={runPreview} type="button">
            {previewing ? "Đang tính…" : "Xem sản phẩm khớp hiện tại"}
          </button>
        </div>
        <div aria-live="polite" className="mt-3 min-h-6 text-sm" role="status">
          {preview === null ? null : preview.kind === "GLOBAL" ? (
            <p>Phạm vi toàn đơn: tính trên tất cả sản phẩm trả tiền.</p>
          ) : preview.kind === "INVALID" ? (
            <p>Phạm vi chưa hợp lệ. Hãy kiểm tra danh mục và danh sách sản phẩm.</p>
          ) : preview.kind === "UNAVAILABLE" ? (
            <p>
              {preview.code === "scope-frozen-empty"
                ? "Hiện chưa có sản phẩm nào khớp."
                : "Có quá nhiều sản phẩm khớp để chốt danh sách. Hãy thu hẹp phạm vi."}
            </p>
          ) : (
            <p>
              Hiện có <strong>{preview.matchCount}</strong> sản phẩm khớp
              {preview.names.length > 0 ? `: ${preview.names.map((item) => item.name).join(", ")}${preview.matchCount > preview.names.length ? ", …" : ""}` : ""}
              .{" "}
              {preview.frozenAtPublish
                ? "Danh sách sẽ được chốt khi bật chiến dịch."
                : "Danh sách tự cập nhật khi danh mục thay đổi."}
            </p>
          )}
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <button className={primaryButtonClassName} type="submit">
          {mode === "create" ? "Tạo bản nháp" : "Lưu thay đổi"}
        </button>
      </div>
    </form>
  );
}
