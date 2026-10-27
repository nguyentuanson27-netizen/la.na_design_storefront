"use client";

import { useRouter } from "next/navigation";
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
  QUOTE_UNAVAILABLE: "Chưa tính được giá cho ưu đãi này lúc này, nên chưa áp dụng. Nàng thử lại sau giây lát nhé.",
  OFFER_CHANGED: "Mã ưu đãi từ liên kết vừa được thay bằng một mã khác ở trang khác, nên chưa áp dụng. Nàng xem lại mã đang được đề nghị rồi bấm lại nhé.",
};
const GENERIC_ERROR = "Chưa cập nhật được ưu đãi. Nàng thử lại sau giây lát nhé.";

export function VoucherPicker({ initial, linkOffer = null }: Readonly<{ initial: VoucherPickerModel; linkOffer?: string | null }>) {
  const { previewDraft, commitDraft, applyCode, applyLinkedCode, dismissLinkedOffer } = useVoucherPickerActions();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [saved, setSaved] = useState(initial);
  // The version of the SAVED choice this picker was built on. It only moves when the picker learns what is saved (a commit, an
  // applied code, a refusal that returns the saved model): never from a preview of a draft, which would hide that another tab
  // changed the choice underneath this one. "Áp dụng" sends it back so a stale picker is refused instead of overwriting.
  const [baseVersion, setBaseVersion] = useState<string | null>(initial.selectionVersion);
  const [model, setModel] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [open, setOpen] = useState(false);
  // Whether the dialog is open RIGHT NOW (a Server Action that resolves after the shopper closed it must still settle what it saved).
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A code from a marketing link is OFFERED, never applied or even shown: it stays on the server, and "Dùng mã từ liên kết" asks the
  // server to use it (the same verify, quote and consent as a typed code).
  const [code, setCode] = useState("");
  const [pendingLink, setPendingLink] = useState(false);
  // Once the linked code is used the offer disappears from the dialog at once; the server-side cookie is cleared when the dialog closes.
  const [linkUsed, setLinkUsed] = useState(false);
  // The opaque handle of the offer this page SHOWED; it goes back with the click so only that offer can be applied.
  const linkVisible = linkOffer !== null && !linkUsed;
  const linkApplied = useRef(false);
  const linkToken = useRef<string | null>(null);
  // The token is an opaque handle the server gave back for the offer just used (never the code): it lets the close clear THAT offer only.
  const markLinkUsed = (result: unknown) => {
    linkApplied.current = true;
    linkToken.current = (result as { offerToken?: string }).offerToken ?? null;
    setLinkUsed(true);
  };
  // A valid code whose choice costs something the shopper has not agreed to: verified, shown, NOT saved. It is saved by the
  // same "Áp dụng" press that carries the consent (the server re-verifies the code and the quote then).
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A write (a code or a choice being applied) is in flight. Leaving stays possible, but then it does NOT cancel: the request still lands.
  const [saving, setSaving] = useState(false);
  // `saving` is set OUTSIDE the transition on purpose: state set inside an async transition is only shown when the whole action ends,
  // and the point of it is to be shown while the action is still running.
  const saveWith = (run: () => Promise<void>) => {
    setSaving(true);
    startTransition(async () => {
      try {
        await run();
      } finally {
        setSaving(false);
      }
    });
  };

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      element.showModal();
      heading.current?.focus();
    } else if (!open && element?.open) element.close();
  }, [open]);

  // A code is saved on the server the moment it is accepted, but the page behind the open dialog is not refreshed (that
  // would remount the picker and close it). Closing the dialog is when the totals outside it must catch up.
  const router = useRouter();
  const codeApplied = useRef(false);
  const settleCodeApplied = () => {
    if (linkApplied.current) {
      // The dialog is closed now, so clearing the cookie (which re-renders the page) costs the shopper nothing.
      linkApplied.current = false;
      codeApplied.current = false;
      const token = linkToken.current;
      linkToken.current = null;
      void (token === null ? Promise.resolve() : dismissLinkedOffer({ offerToken: token })).then(() => router.refresh());
      return;
    }
    if (!codeApplied.current) return;
    codeApplied.current = false;
    router.refresh();
  };

  // A code is recorded as saved only when its Server Action RESOLVES. The shopper may have closed the dialog while it was running (Back or
  // Escape are not blocked: nothing is lost by leaving), and then no later close will come, so the refresh and the clearing of a used
  // linked offer happen here instead.
  const settleIfClosed = () => {
    if (!openRef.current) settleCodeApplied();
  };

  const close = () => {
    openRef.current = false;
    settleCodeApplied();
    setPendingCode(null);
    setPendingLink(false);
    setOpen(false);
    setConfirming(false);
    setError(null);
    setMessage(null);
    setCode("");
    setModel(saved);
    setDraft(draftOf(saved));
  };

  const choose = (key: "merchandise" | "shipping", voucherId: string | null) => {
    const next: Draft = { ...draft, [key]: { mode: "MANUAL", voucherId } };
    setPendingCode(null);
    setPendingLink(false);
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

  // Editing the box abandons a code that was waiting for the shopper's yes: the confirmation belongs to THAT code and the quote
  // shown for it, so it must not be sent for a different text. What the picker shows goes back to what is saved.
  const editCode = (value: string) => {
    setCode(value);
    if ((pendingCode !== null && value !== pendingCode) || pendingLink) {
      setPendingCode(null);
      setPendingLink(false);
      setConfirming(false);
      setMessage(null);
      setError(null);
      setModel(saved);
      setDraft(draftOf(saved));
    }
  };

  const submitCode = () => {
    setError(null);
    saveWith(async () => {
      const result = await applyCode({ code });
      if (result.ok && result.picker) {
        setSaved(result.picker);
        setBaseVersion(result.picker.selectionVersion);
        setModel(result.picker);
        setDraft(draftOf(result.picker));
        setCode("");
        setPendingCode(null);
        setPendingLink(false);
        setConfirming(false);
        codeApplied.current = true;
        setMessage("Đã áp dụng mã ưu đãi.");
        settleIfClosed();
      } else if (result.ok) {
        // Saved on the server, but the picker could not be re-read right now: it is NOT a failure. Say what happened and let the
        // page behind the dialog show the server's numbers when the dialog closes.
        setCode("");
        setPendingCode(null);
        setPendingLink(false);
        setConfirming(false);
        codeApplied.current = true;
        setMessage("Đã áp dụng mã ưu đãi. Giá dự kiến sẽ được cập nhật khi nàng đóng hộp thoại.");
        settleIfClosed();
      } else if (!result.ok && (result.reason === "CONFIRMATION_REQUIRED" || result.reason === "QUOTE_CHANGED")) {
        // The code is valid but nothing is saved yet: show what the server derives for it and ask for the shopper's yes.
        if (result.picker) {
          setModel(result.picker);
          setDraft(draftOf(result.picker));
        }
        // The typed code is now the one waiting for the yes; a linked step that was waiting no longer is.
        setPendingCode(code);
        setPendingLink(false);
        setConfirming(result.reason === "CONFIRMATION_REQUIRED");
        setMessage("Mã hợp lệ. Nàng xem ưu đãi và lưu ý bên dưới, rồi bấm xác nhận để áp dụng.");
      } else setError(result.ok ? GENERIC_ERROR : (CODE_ERROR[result.reason] ?? GENERIC_ERROR));
    });
  };

  // The offer this page showed is no longer the one the server holds (another tab opened a newer link, or used it). Nothing was applied.
  // Whichever step noticed -- the first click or the consent -- drops the old offer's pending step AND its quote and warnings, so the
  // shopper is not left confirming a code that can no longer be applied, then re-renders the page to show what is on offer now.
  const offerGone = (reason: "OFFER_CHANGED" | "INVALID_CODE") => {
    setPendingCode(null);
    setPendingLink(false);
    setConfirming(false);
    setModel(saved);
    setDraft(draftOf(saved));
    setMessage(null);
    setError(CODE_ERROR[reason]!);
    router.refresh();
  };

  // The code a marketing link left on the server. The browser never has it: this asks the server to use it.
  const submitLinked = () => {
    setError(null);
    saveWith(async () => {
      const result = await applyLinkedCode({ offerToken: linkOffer });
      if (result.ok && result.picker) {
        setSaved(result.picker);
        setBaseVersion(result.picker.selectionVersion);
        setModel(result.picker);
        setDraft(draftOf(result.picker));
        // What is shown is the linked code's result, so a typed code that was waiting for its yes no longer is: its confirmation
        // (and the footer button that carries it) must not outlive the quote it was given for.
        setPendingCode(null);
        setPendingLink(false);
        setConfirming(false);
        codeApplied.current = true;
        markLinkUsed(result);
        setMessage("Đã áp dụng mã ưu đãi.");
        settleIfClosed();
      } else if (result.ok) {
        setPendingCode(null);
        setPendingLink(false);
        setConfirming(false);
        codeApplied.current = true;
        markLinkUsed(result);
        setMessage("Đã áp dụng mã ưu đãi. Giá dự kiến sẽ được cập nhật khi nàng đóng hộp thoại.");
        settleIfClosed();
      } else if (!result.ok && (result.reason === "CONFIRMATION_REQUIRED" || result.reason === "QUOTE_CHANGED")) {
        if (result.picker) {
          setModel(result.picker);
          setDraft(draftOf(result.picker));
        }
        // The linked code is now the one waiting for the yes; a typed code that was waiting no longer is.
        setPendingCode(null);
        setPendingLink(true);
        setConfirming(result.reason === "CONFIRMATION_REQUIRED");
        setMessage("Mã hợp lệ. Nàng xem ưu đãi và lưu ý bên dưới, rồi bấm xác nhận để áp dụng.");
      } else if (!result.ok && result.reason === "OFFER_CHANGED") {
        offerGone("OFFER_CHANGED");
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
    saveWith(async () => {
      // The consent is the digest of the quote the shopper just read and a yes; the server recomputes what is lost.
      const consent = confirming && model.quoteDigest !== null ? { acknowledged: true as const, expectedQuoteDigest: model.quoteDigest } : undefined;
      // A verified code waiting for the shopper's yes is saved through the code path (the server re-verifies the code and the quote).
      const result = pendingLink
        ? await applyLinkedCode(consent ? { offerToken: linkOffer, consent } : { offerToken: linkOffer })
        : pendingCode !== null
        ? await applyCode(consent ? { code: pendingCode, consent } : { code: pendingCode })
        : await commitDraft({ ...draft, selection: baseVersion ?? "", ...(consent ? { consent } : {}) });
      if (result.ok && result.picker) {
        if (pendingCode !== null || pendingLink) {
          if (pendingLink) markLinkUsed(result);
          setPendingCode(null);
          setPendingLink(false);
          setCode("");
          codeApplied.current = true;
        }
        setSaved(result.picker);
        setBaseVersion(result.picker.selectionVersion);
        setModel(result.picker);
        setDraft(draftOf(result.picker));
        setOpen(false);
        setConfirming(false);
        setMessage(null);
        settleCodeApplied();
      } else if (result.ok) {
        // Saved on the server, but the picker could not be re-read right now: not a failure, and not a promise about the price either.
        // Say so plainly and keep the dialog open; the page behind is refreshed when the shopper closes it.
        if (pendingLink) markLinkUsed(result);
        setPendingCode(null);
        setPendingLink(false);
        setCode("");
        setConfirming(false);
        codeApplied.current = true;
        setMessage("Đã lưu lựa chọn ưu đãi. Hiện chưa tính được giá, nên giá cuối cùng sẽ được báo lại trước khi nàng đặt hàng.");
        settleIfClosed();
      } else if (pendingLink && !result.ok && (result.reason === "OFFER_CHANGED" || result.reason === "INVALID_CODE")) {
        offerGone(result.reason);
      } else if (!result.ok && result.reason === "SELECTION_CHANGED") {
        // Another page changed the choice this one was built on. Nothing was written. Take what is saved now (the server sends it) and let the
        // shopper choose again from it, instead of writing a stale half of the choice over the newer one.
        const fresh = (result as { picker?: VoucherPickerModel | null }).picker;
        setPendingCode(null);
        setPendingLink(false);
        setConfirming(false);
        if (fresh) {
          setSaved(fresh);
          setBaseVersion(fresh.selectionVersion);
          setModel(fresh);
          setDraft(draftOf(fresh));
          setError("Ưu đãi vừa được thay đổi ở một trang khác. Nàng xem lại lựa chọn bên dưới rồi bấm Áp dụng nhé.");
        } else setError(GENERIC_ERROR);
      } else if (!result.ok && (result.reason === "QUOTE_CHANGED" || result.reason === "CONFIRMATION_REQUIRED")) {
        // Nothing was saved. Show what the server derives now and ask again.
        setConfirming(false);
        setError("Giá hoặc ưu đãi vừa thay đổi. Nàng xem lại số tiền và quà bên dưới rồi xác nhận lại nhé.");
        const refused = (result as { picker?: VoucherPickerModel | null }).picker;
        if ((pendingCode !== null || pendingLink) && refused) {
          setModel(refused);
          setDraft(draftOf(refused));
        } else {
          const again = await previewDraft(draft);
          if (again.ok) setModel(again.picker);
        }
      } else setError(!result.ok && result.reason === "QUOTE_UNAVAILABLE" ? CODE_ERROR.QUOTE_UNAVAILABLE! : GENERIC_ERROR);
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
            <button type="button" className="inline-flex h-11 w-11 items-center justify-center text-xl focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={saving ? "Đóng — yêu cầu áp dụng vẫn tiếp tục" : "Quay lại, giữ lựa chọn cũ"} onClick={close}>
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
              <input id={`${titleId}-code`} value={code} onChange={(event) => editCode(event.target.value)} maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="Nhập mã khuyến mãi" className="min-h-11 min-w-0 flex-1 border border-black/30 bg-transparent px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2" />
              <button type="submit" disabled={pending || code.trim() === ""} className="min-h-11 border border-black px-4 text-sm font-semibold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2">Áp dụng mã</button>
            </form>

            {error ? <p role="alert" className="mt-3 border-l-2 border-black bg-black/5 p-3 text-sm">{error}</p> : null}
            {model.warnings.notices.map((notice) => <p key={notice} role="status" className="mt-3 text-sm text-black/80">{notice}</p>)}

            {linkVisible ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-black/20 p-3 text-sm">
                <p>Nàng có mã ưu đãi từ liên kết.</p>
                <button type="button" disabled={pending} onClick={submitLinked} className="min-h-11 border border-black px-4 text-sm font-semibold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2">Dùng mã từ liên kết</button>
              </div>
            ) : null}

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
            {saving ? <p role="status" className="mt-3 text-sm text-black/80">Đang áp dụng ưu đãi. Nếu nàng đóng hộp thoại, ưu đãi vẫn được áp dụng.</p> : null}
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
