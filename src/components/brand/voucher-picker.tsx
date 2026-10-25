"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { useVoucherPickerActions } from "@/components/headless/use-voucher-picker";
import type { VoucherPickerGroup, VoucherPickerModel } from "@/routes/voucher-picker-model";
import { VoucherCard } from "./voucher-card";

/**
 * Voucher v1 (V16): the Grab-inspired picker (spec §7). Mobile is a full-screen sheet with a sticky footer, desktop a
 * centred panel; both are a native modal <dialog>, which gives the inert background, focus containment and Escape.
 *
 * It owns no pricing and no eligibility. A radio change only asks the server for a preview of that DRAFT (nothing is
 * saved, nothing is held); "Áp dụng" commits both groups in one server call and the picker shows what the server
 * answered, never what the browser expected. Closing or going back discards the draft and keeps the old choice.
 *
 * When the cart changes, the page re-renders it with a new `key` (see `voucherPickerKey`), which remounts the picker
 * on the fresh server model instead of syncing state from props in an effect.
 */

type Draft = Readonly<{
  merchandise: Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;
  shipping: Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;
}>;

const draftOf = (model: VoucherPickerModel): Draft => {
  const of = (group: VoucherPickerGroup) => ({ mode: group.mode, voucherId: group.mode === "MANUAL" ? (group.items.find((item) => item.selected)?.id ?? null) : null }) as const;
  return { merchandise: of(model.groups[0]), shipping: of(model.groups[1]) };
};

const CODE_ERROR: Readonly<Record<string, string>> = {
  INVALID_CODE: "Mã không hợp lệ hoặc đã hết hiệu lực. Nàng kiểm tra lại mã nhé.",
  VOUCHER_UNAVAILABLE: "Voucher này đã hết lượt.",
  RATE_LIMITED: "Nàng đã thử mã quá nhiều lần. Vui lòng thử lại sau ít phút.",
  FEATURE_DISABLED: "Ưu đãi tạm thời chưa khả dụng.",
  CART_UNAVAILABLE: "Giỏ hàng không còn khả dụng. Nàng tải lại trang nhé.",
};
const GENERIC_ERROR = "Chưa cập nhật được ưu đãi. Nàng thử lại sau giây lát nhé.";

export function VoucherPicker({ initial, prefillCode = null }: Readonly<{ initial: VoucherPickerModel; prefillCode?: string | null }>) {
  const { previewDraft, commitDraft, applyCode } = useVoucherPickerActions();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [saved, setSaved] = useState(initial);
  const [model, setModel] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A code from a marketing link is offered, not applied: the shopper confirms it with "Áp dụng mã".
  const [code, setCode] = useState(prefillCode ?? "");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      element.showModal();
      heading.current?.focus();
    } else if (!open && element?.open) element.close();
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirming(false);
    setError(null);
    setMessage(null);
    setCode(prefillCode ?? "");
    setModel(saved);
    setDraft(draftOf(saved));
  };

  const choose = (key: "merchandise" | "shipping", voucherId: string | null) => {
    const next: Draft = { ...draft, [key]: { mode: "MANUAL", voucherId } };
    setDraft(next);
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      const result = await previewDraft(next);
      if (result.ok) {
        setModel(result.picker);
        setMessage(`Tổng thanh toán dự kiến ${result.picker.summary.totalText}`);
      } else setError(GENERIC_ERROR);
    });
  };

  const submitCode = () => {
    setError(null);
    startTransition(async () => {
      const result = await applyCode({ code });
      if (result.ok && result.picker) {
        setSaved(result.picker);
        setModel(result.picker);
        setDraft(draftOf(result.picker));
        setCode("");
        setMessage("Đã áp dụng mã ưu đãi.");
      } else setError(result.ok ? GENERIC_ERROR : (CODE_ERROR[result.reason] ?? GENERIC_ERROR));
    });
  };

  const apply = () => {
    const warned = model.warnings.giftLoss !== null || model.warnings.totalIncrease !== null;
    if (warned && !confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await commitDraft(draft);
      if (result.ok && result.picker) {
        setSaved(result.picker);
        setModel(result.picker);
        setDraft(draftOf(result.picker));
        setOpen(false);
        setConfirming(false);
        setMessage(null);
      } else setError(GENERIC_ERROR);
    });
  };

  const warnings = [model.warnings.giftLoss, model.warnings.totalIncrease].filter((text): text is string => text !== null);
  const summary = saved.footer.count > 0 ? `Đang dùng ${saved.footer.count} ưu đãi · Dự kiến ${saved.summary.totalText}` : "Chọn hoặc nhập mã ưu đãi";

  return (
    <div data-voucher-picker>
      <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 border border-black/30 px-4 py-3 text-left text-sm font-semibold hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span>Ưu đãi</span>
        <span className="text-right font-normal text-black/75">{summary}</span>
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); close(); }}
        className="m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-[#fcf8f6] p-0 text-[#30251f] backdrop:bg-black/45 sm:m-auto sm:h-auto sm:max-h-[85dvh] sm:max-w-lg sm:border sm:border-black/25"
      >
        <div className="flex h-dvh flex-col sm:h-auto sm:max-h-[85dvh]">
          <header className="flex items-center gap-3 border-b border-black/15 px-4 py-3">
            <button type="button" className="inline-flex h-11 w-11 items-center justify-center text-xl focus-visible:outline-2 focus-visible:outline-offset-2" aria-label="Quay lại, giữ lựa chọn cũ" onClick={close}>
              <span aria-hidden="true">←</span>
            </button>
            <h2 id={titleId} ref={heading} tabIndex={-1} className="font-display text-xl">Ưu đãi</h2>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <form
              className="flex gap-2"
              onSubmit={(event) => { event.preventDefault(); if (code.trim()) submitCode(); }}
            >
              <label className="sr-only" htmlFor={`${titleId}-code`}>Nhập mã khuyến mãi</label>
              <input id={`${titleId}-code`} value={code} onChange={(event) => setCode(event.target.value)} maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="Nhập mã khuyến mãi" className="min-h-11 min-w-0 flex-1 border border-black/30 bg-transparent px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2" />
              <button type="submit" disabled={pending || code.trim() === ""} className="min-h-11 border border-black px-4 text-sm font-semibold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2">Áp dụng mã</button>
            </form>

            {error ? <p role="alert" className="mt-3 border-l-2 border-black bg-black/5 p-3 text-sm">{error}</p> : null}
            {model.warnings.notices.map((notice) => <p key={notice} role="status" className="mt-3 text-sm text-black/80">{notice}</p>)}

            {prefillCode ? <p className="mt-3 text-sm text-black/80">Nàng có mã ưu đãi từ liên kết. Bấm “Áp dụng mã” để dùng.</p> : null}

            {model.groups.map((group, index) => {
              if (group.items.length === 0) return null;
              const key = index === 0 ? "merchandise" : "shipping";
              const name = `voucher-${group.kind}`;
              return (
                <fieldset key={group.kind} className="mt-6" disabled={pending}>
                  <legend className="flex w-full items-baseline justify-between text-sm font-semibold">
                    <span>{group.heading}</span>
                    <span className="font-normal text-black/65">{group.hint}</span>
                  </legend>
                  <ul className="mt-2 space-y-2">
                    <li>
                      <label className={`flex min-h-11 cursor-pointer items-center gap-3 border px-3 py-2 ${group.noneSelected ? "border-black" : "border-black/20"}`}>
                        <input type="radio" name={name} value="" checked={group.noneSelected} onChange={() => choose(key, null)} className="h-5 w-5 accent-black" />
                        <span className="text-sm">{group.noneLabel}</span>
                      </label>
                    </li>
                    {group.items.map((item) => (
                      <VoucherCard key={item.id} item={item} name={name} disabled={pending} onSelect={() => choose(key, item.id)} />
                    ))}
                  </ul>
                </fieldset>
              );
            })}

            <dl className="mt-6 space-y-1.5 border-t border-black/15 pt-4 text-sm">
              <div className="flex justify-between gap-4"><dt>Tiền hàng</dt><dd>{model.summary.paidBeforeText}</dd></div>
              {model.summary.merchandiseDiscountText ? <div className="flex justify-between gap-4"><dt>Voucher giảm tiền hàng</dt><dd>{model.summary.merchandiseDiscountText}</dd></div> : null}
              <div className="flex justify-between gap-4"><dt>Phí vận chuyển</dt><dd>{model.summary.shippingFeeText}</dd></div>
              {model.summary.shippingDiscountText ? <div className="flex justify-between gap-4"><dt>Voucher vận chuyển</dt><dd>{model.summary.shippingDiscountText}</dd></div> : null}
              <div className="flex justify-between gap-4 text-base font-semibold"><dt>Dự kiến thanh toán</dt><dd>{model.summary.totalText}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-black/65">Đây là số dự kiến; ưu đãi chưa được giữ cho đến khi nàng đặt hàng.</p>

            {warnings.length > 0 ? (
              <div role="alert" className="mt-4 border-l-2 border-black bg-black/5 p-3 text-sm leading-6">
                {warnings.map((text) => <p key={text}>{text}</p>)}
              </div>
            ) : null}
          </div>

          <footer className="sticky bottom-0 border-t border-black/15 bg-[#fcf8f6] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <p role="status" aria-live="polite" className="sr-only">{message ?? ""}</p>
            {confirming ? (
              <div className="flex flex-col gap-2">
                <button type="button" className="btn btn--primary min-h-11" disabled={pending} onClick={apply}>Tiếp tục với voucher này</button>
                <button type="button" className="btn btn--secondary min-h-11" onClick={() => setConfirming(false)}>Đổi voucher</button>
              </div>
            ) : (
              <button type="button" className="btn btn--primary min-h-11 w-full" disabled={pending} onClick={apply}>
                {warnings.length > 0 ? `Xem lại và ${model.footer.label}` : model.footer.label}
              </button>
            )}
          </footer>
        </div>
      </dialog>
    </div>
  );
}
