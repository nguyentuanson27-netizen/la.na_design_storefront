"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";

import { BRAND } from "@/brand";
import {
  resolveTryOnPrivacyDisclosure,
  type TryOnDisclosureProvider,
} from "@/components/headless/try-on-disclosure";
import {
  TRY_ON_AGE_OPTIONS,
  TRY_ON_BETA_BADGE,
  TRY_ON_BETA_NOTE,
  TRY_ON_BLOCKED_AGE_MESSAGE,
  TRY_ON_LIKENESS_ACKNOWLEDGEMENT,
  TRY_ON_PHOTO_DONTS,
  TRY_ON_PHOTO_DOS,
  TRY_ON_STEP_COUNT,
  TRY_ON_TEEN_ATTESTATION_LEAD,
  TRY_ON_TEEN_DISCLOSURE,
  TRY_ON_WAIT_NOTE,
  isLoginRequired,
} from "@/components/headless/try-on-model";
import { useTryOn } from "@/components/headless/use-try-on";

/**
 * Virtual try-on on the PDP (`docs/specs/storefront-virtual-try-on.md` §6, §13, §14).
 *
 * Markup and focus only. The photo, the attestations, the steps, the request and the result are
 * `useTryOn`'s; this file decides how they look. It shares nothing with the purchase panel, so the
 * dialog can fail or be dismissed without touching the cart or the variant selection.
 *
 * The entry point and the dialog are separate components. The trigger is a text link that sits on
 * the same line as the size guide, inside the purchase panel; the dialog is a native modal `<dialog>`
 * rendered beside it by the coordinator, which owns the one `open` flag and the trigger ref. The
 * native dialog supplies the focus trap, the inert page behind it and Escape; closing it by any
 * route drops the photo and the result and returns focus to the trigger.
 *
 * A bottom sheet below `sm`, a centred 440 px modal from `sm` up. Three short steps — photo, age and
 * confirmation, result — so no step needs scrolling on a phone but the teen path, and the result is
 * the whole of the last step instead of something below a long form.
 */

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const ERROR_TEXT = "text-[#8a1c1c]";
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]";
const PEER_FOCUS_RING =
  "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#3B2219]";
const TEXT_BUTTON = `min-h-11 text-sm font-semibold underline underline-offset-4 ${FOCUS_RING}`;

function PersonIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M5 20.5c.6-3.8 3.4-6 7-6s6.4 2.2 7 6" />
    </svg>
  );
}

/**
 * The entry point: a text link beside "Hướng dẫn chọn size", in the same style, because both help
 * the shopper choose (owner request 2026-10-08). It was briefly a full-width outlined row of its own,
 * which pushed the purchase buttons down; the phone reminder (`BrandTryOnNudge`) is what keeps a
 * shopper who read past it from missing it. A small mark says it is still in development, and the
 * accessible name says the rest of what the row used to: on your own photo, free. Its name still
 * begins "Thử đồ".
 */
export function BrandTryOnTrigger({
  onOpen,
  triggerRef,
}: Readonly<{ onOpen: () => void; triggerRef: RefObject<HTMLButtonElement | null> }>) {
  return (
    <button
      ref={triggerRef}
      type="button"
      className={`group inline-flex min-h-11 items-center gap-2 text-sm text-[#3B2219] ${FOCUS_RING} focus-visible:outline-offset-4`}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <PersonIcon />
      <span className="underline decoration-[#3B2219]/30 underline-offset-[5px] transition-colors group-hover:decoration-[#3B2219]">
        Thử đồ AI
      </span>
      <span className="sr-only"> bằng ảnh của bạn, hoàn toàn miễn phí,</span>
      <span className="border border-[#3B2219]/50 px-1 text-[9px] font-semibold uppercase leading-[14px] tracking-[0.12em]">
        Beta
      </span>
    </button>
  );
}

/**
 * A small prompt that floats just above the phone's purchase bar once the shopper has scrolled past
 * the entry point, so a shopper who read the description is reminded without the page gaining a
 * banner. It leaves the right edge free for the chat button, and can be put away.
 */
export function BrandTryOnNudge({
  onOpen,
  onDismiss,
  openRef,
}: Readonly<{
  onOpen: () => void;
  onDismiss: () => void;
  /** The coordinator's handle on the button that opens the dialog, so focus can come back to it. */
  openRef: RefObject<HTMLButtonElement | null>;
}>) {
  return (
    <div className="absolute bottom-full left-4 mb-2 flex max-w-[calc(100%-5.5rem)] items-stretch border border-[#3B2219] bg-[#FAF7F2] shadow-[0_4px_16px_rgba(0,0,0,0.12)]">
      <button
        ref={openRef}
        type="button"
        className={`flex min-h-11 min-w-0 items-center gap-2 px-3 text-left text-[13px] leading-4 text-[#3B2219] ${FOCUS_RING}`}
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <PersonIcon />
        <span>
          Chưa chắc hợp? <span className="font-semibold underline underline-offset-4">Thử đồ bằng ảnh của bạn</span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Ẩn gợi ý thử đồ"
        className={`min-h-11 min-w-11 shrink-0 border-l border-[#3B2219]/20 text-lg leading-none text-[#3B2219]/70 ${FOCUS_RING}`}
        onClick={onDismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

export function BrandTryOnDialog({
  productSlug,
  productName,
  provider,
  open,
  onOpenChange,
  returnFocusRef,
}: Readonly<{
  productSlug: string;
  productName: string;
  provider: TryOnDisclosureProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whatever opened the dialog: focus goes back there, so it must be the control the shopper used. */
  returnFocusRef: RefObject<HTMLElement | null>;
}>) {
  const ids = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const shownStepRef = useRef<number | null>(null);
  const tryOn = useTryOn({ productSlug, fileInputRef });
  const { step, phase, result } = tryOn;
  const privacyDisclosure = resolveTryOnPrivacyDisclosure(provider, BRAND.identity.name);

  // The coordinator owns `open`; the native dialog is brought in line with it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // What is left today is asked for each time the dialog opens, so it is never a stale number.
  const { refreshQuota } = tryOn;
  useEffect(() => {
    if (open) void refreshQuota();
    // `refreshQuota` is recreated every render; only opening should ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Moving between steps replaces the content under the shopper's focus, so focus follows to the new
  // step's heading. The first step is not announced this way: the dialog's own opening focus does it.
  useEffect(() => {
    if (!open) {
      shownStepRef.current = null;
      return;
    }
    const previous = shownStepRef.current;
    shownStepRef.current = tryOn.stepNumber;
    if (previous !== null && previous !== tryOn.stepNumber) headingRef.current?.focus();
  }, [open, tryOn.stepNumber]);

  // Runs for Escape, the close button and `dialog.close()` alike.
  function handleClosed() {
    tryOn.reset();
    onOpenChange(false);
    returnFocusRef.current?.focus({ preventScroll: true });
  }

  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getClientRects().length > 0,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const titleId = `${ids}-title`;
  const fileHelpId = `${ids}-file-help`;
  const fileErrorId = `${ids}-file-error`;
  const attestationId = `${ids}-attestation`;
  const hintId = `${ids}-hint`;
  const showHint = !tryOn.canGenerate && !tryOn.isBlockedAge;

  const headingClass = "mb-3 text-base font-semibold outline-none";

  function renderProgress() {
    return (
      <div className="mb-3 flex items-center gap-1.5 text-xs text-black/60">
        {Array.from({ length: TRY_ON_STEP_COUNT }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`h-1 w-6 rounded-full ${index < tryOn.stepNumber ? "bg-[#3B2219]" : "bg-black/15"}`}
          />
        ))}
        <span className="ml-1.5">
          Bước {tryOn.stepNumber}/{TRY_ON_STEP_COUNT}
        </span>
      </div>
    );
  }

  function renderPhotoStep() {
    return (
      <>
        <h3 ref={headingRef} tabIndex={-1} className={headingClass}>
          Chọn ảnh của bạn
        </h3>
        {phase === "error" && tryOn.errorMessage ? (
          <p role="alert" className={`mb-3 text-sm font-semibold ${ERROR_TEXT}`}>
            {tryOn.errorMessage}
          </p>
        ) : null}
        {/* The native control reads "Choose File / No file chosen" in the browser's language, so it is
            kept for keyboard, screen-reader and file-picker behaviour but hidden, and the Vietnamese
            tile below is its label. `peer` carries its focus ring onto that tile. */}
        <input
          ref={fileInputRef}
          id={`${ids}-photo`}
          type="file"
          accept="image/jpeg,image/png"
          className="peer sr-only"
          aria-label="Ảnh của bạn (JPG hoặc PNG, tối đa 7 MB)"
          aria-describedby={tryOn.fileError ? `${fileHelpId} ${fileErrorId}` : fileHelpId}
          aria-invalid={tryOn.fileError ? "true" : undefined}
          onChange={tryOn.chooseFile}
        />
        <label
          htmlFor={`${ids}-photo`}
          className={`flex h-56 cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[10px] border-2 border-dashed border-[#a79a8c] bg-white/40 text-[#6b5f52] ${PEER_FOCUS_RING}`}
        >
          {tryOn.previewUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview; next/image cannot optimise it. */}
              <img
                src={tryOn.previewUrl}
                alt="Ảnh bạn đã chọn"
                className="max-h-44 w-auto max-w-full object-contain"
              />
              <span className="text-sm font-semibold underline underline-offset-4">Đổi ảnh</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="text-3xl leading-none">
                +
              </span>
              <span className="text-sm font-semibold">Chọn ảnh</span>
              <span className="text-xs">JPG hoặc PNG, tối đa 7 MB</span>
            </>
          )}
        </label>
        {tryOn.fileError ? (
          <p id={fileErrorId} role="alert" className={`mt-2 text-sm font-semibold ${ERROR_TEXT}`}>
            {tryOn.fileError}
          </p>
        ) : null}
        <div id={fileHelpId} className="mt-3 grid grid-cols-2 gap-x-4 text-[13px] leading-5">
          <div>
            <p className="font-semibold">Nên chọn</p>
            <ul className="mt-1 space-y-1 text-black/70">
              {TRY_ON_PHOTO_DOS.map((tip) => (
                <li key={tip} className="flex gap-1.5">
                  <span aria-hidden="true" className="text-[#3B2219]">
                    ✓
                  </span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold">Nên tránh</p>
            <ul className="mt-1 space-y-1 text-black/70">
              {TRY_ON_PHOTO_DONTS.map((tip) => (
                <li key={tip} className="flex gap-1.5">
                  <span aria-hidden="true" className={ERROR_TEXT}>
                    ✕
                  </span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-black/60">
          Chỉ 3 bước nhẹ nhàng: chọn ảnh, xác nhận, nhận ảnh thử đồ sau khoảng 30–60 giây.
        </p>
        {tryOn.quotaLine ? (
          <p className="mt-3 border-t border-black/10 pt-3 text-[13px] leading-5 text-black/75">
            {tryOn.quotaLine}
            {tryOn.quota?.audience === "guest" ? (
              <>
                {" "}
                <a href={tryOn.loginHref} className={`font-semibold underline underline-offset-4 ${FOCUS_RING}`}>
                  Tạo tài khoản
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn--primary mt-4 w-full px-4"
          disabled={!tryOn.canContinue}
          onClick={tryOn.continueToConfirm}
        >
          Tiếp tục
        </button>
      </>
    );
  }

  function renderConfirmStep() {
    return (
      <>
        <h3 ref={headingRef} tabIndex={-1} className={headingClass}>
          Độ tuổi và xác nhận
        </h3>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-black/15 bg-white/50 px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2.5">
            {tryOn.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local blob preview; next/image cannot optimise it.
              <img
                src={tryOn.previewUrl}
                alt="Ảnh bạn đã chọn"
                className="h-10 w-8 shrink-0 rounded-[3px] border border-black/15 object-cover"
              />
            ) : null}
            <span className="truncate">Ảnh đã chọn</span>
          </span>
          <button type="button" className={TEXT_BUTTON} onClick={tryOn.changePhoto}>
            Đổi
          </button>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-semibold">Độ tuổi của bạn</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TRY_ON_AGE_OPTIONS.map((option) => {
              const selected = tryOn.ageState === option.value;
              return (
                <label key={option.value} className="relative">
                  <input
                    type="radio"
                    name={`${ids}-age`}
                    value={option.value}
                    checked={selected}
                    className="peer sr-only"
                    aria-describedby={selected && tryOn.isTeen ? attestationId : undefined}
                    onChange={() => tryOn.setAgeState(option.value)}
                  />
                  <span
                    className={`flex min-h-11 cursor-pointer items-center rounded-full border border-[#3B2219] px-3.5 text-[13px] ${PEER_FOCUS_RING} peer-checked:bg-[#3B2219] peer-checked:text-[#FAF7F2]`}
                  >
                    {option.shortLabel}
                  </span>
                </label>
              );
            })}
          </div>
          {tryOn.isBlockedAge ? (
            <p role="alert" className={`mt-2 text-sm font-semibold ${ERROR_TEXT}`}>
              {TRY_ON_BLOCKED_AGE_MESSAGE}
            </p>
          ) : null}
          {tryOn.isTeen ? (
            <div id={attestationId} className="mt-3 border-l-[3px] border-[#3B2219] bg-[#3B2219]/5 px-3 py-2 text-[13px] leading-5 text-black/80">
              <p className="font-semibold">{TRY_ON_TEEN_ATTESTATION_LEAD}</p>
              <p className="mt-1">
                {TRY_ON_AGE_OPTIONS.find((option) => option.value === tryOn.ageState)?.label}
              </p>
              <p className="mt-2">{TRY_ON_TEEN_DISCLOSURE}</p>
            </div>
          ) : null}
        </fieldset>

        <label className="mt-4 flex min-h-11 items-start gap-3 py-1.5 text-[13px] leading-5">
          <input
            type="checkbox"
            checked={tryOn.acknowledged}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#3B2219]"
            onChange={(event) => tryOn.setAcknowledged(event.target.checked)}
          />
          <span>{TRY_ON_LIKENESS_ACKNOWLEDGEMENT}</span>
        </label>

        <p className="mt-2 text-xs leading-5 text-black/60">{privacyDisclosure.summary}</p>
        <details className="text-xs leading-5 text-black/60">
          <summary className={`inline-block min-h-6 cursor-pointer underline underline-offset-2 ${FOCUS_RING}`}>
            Chi tiết
          </summary>
          <p className="mt-1">{privacyDisclosure.detail}</p>
        </details>

        <button
          type="button"
          className="btn btn--primary mt-4 w-full px-4"
          disabled={!tryOn.canGenerate}
          aria-describedby={showHint ? hintId : undefined}
          onClick={tryOn.generate}
        >
          Tạo ảnh thử đồ
        </button>
        {showHint ? (
          <p id={hintId} className="mt-2 text-xs text-black/60">
            Để tạo ảnh, hãy {tryOn.missingSteps.join(", ")}.
          </p>
        ) : null}
      </>
    );
  }

  function renderResultStep() {
    return (
      <>
        <h3 ref={headingRef} tabIndex={-1} className={headingClass}>
          {phase === "loading" ? "Đang tạo ảnh" : phase === "error" ? "Chưa tạo được ảnh" : "Ảnh thử đồ"}
        </h3>
        <div role="status" aria-live="polite" className="min-h-6 text-sm">
          {phase === "loading" ? (
            <>
              <p>Đang tạo ảnh thử đồ cho bạn…</p>
              <p className="mt-1 text-black/70">{TRY_ON_WAIT_NOTE}</p>
            </>
          ) : null}
          {phase === "success" ? "Đã tạo xong ảnh thử đồ." : null}
        </div>

        {phase === "loading" ? (
          <div
            aria-busy="true"
            className="mt-2 h-72 animate-pulse rounded-lg border border-black/10 bg-black/5"
          />
        ) : null}

        {phase === "success" && result ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob; next/image cannot optimise it. */}
            <img
              src={result.url}
              alt={`Ảnh thử đồ do AI tạo cho ${productName}, chỉ mang tính tham khảo`}
              className="mx-auto mt-2 max-h-[22rem] w-auto max-w-full border border-black/15 object-contain"
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <a
                href={result.url}
                download={`thu-do-${productSlug}.${result.mimeType === "image/png" ? "png" : "jpg"}`}
                className="btn btn--primary px-4"
              >
                Tải ảnh
              </a>
              <button type="button" className="btn btn--outline px-4" onClick={tryOn.backToConfirm}>
                Tạo lại
              </button>
            </div>
            <p className="mt-3 text-xs leading-5 text-black/65">
              Ảnh do AI tạo, chỉ mang tính tham khảo — không đảm bảo kích cỡ, độ vừa vặn, chất liệu hay
              màu sắc thật.
            </p>
            {tryOn.isTeen ? (
              <p className="mt-2 border-l-[3px] border-[#3B2219] pl-3 text-xs leading-5 text-black/75">
                {TRY_ON_TEEN_DISCLOSURE}
              </p>
            ) : null}
            <div className="mt-2 text-center">
              <button type="button" className={TEXT_BUTTON} onClick={tryOn.changePhoto}>
                Dùng ảnh khác
              </button>
            </div>
          </>
        ) : null}

        {phase === "error" && tryOn.errorMessage ? (
          <>
            <p role="alert" className={`mt-2 text-sm font-semibold ${ERROR_TEXT}`}>
              {tryOn.errorMessage}
            </p>
            {tryOn.quotaUpsell ? (
              <div className="mt-4 border-l-[3px] border-[#3B2219] bg-[#3B2219]/5 px-3 py-2 text-[13px] leading-5 text-black/80">
                <p className="font-semibold">{tryOn.quotaUpsell.title}</p>
                <p className="mt-1">{tryOn.quotaUpsell.body}</p>
              </div>
            ) : null}
            {isLoginRequired(tryOn.errorReason) || tryOn.quotaUpsell ? (
              <a href={tryOn.loginHref} className="btn btn--primary mt-4 w-full px-4">
                Đăng ký hoặc đăng nhập
              </a>
            ) : null}
            {isLoginRequired(tryOn.errorReason) ? null : (
              <button
                type="button"
                className={`btn btn--outline w-full px-4 ${tryOn.quotaUpsell ? "mt-3" : "mt-4"}`}
                onClick={tryOn.backToConfirm}
              >
                Quay lại
              </button>
            )}
          </>
        ) : null}
      </>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      tabIndex={-1}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border-0 bg-[#FAF7F2] p-0 text-black shadow-2xl backdrop:bg-black/45 sm:m-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-[440px] sm:rounded-lg"
      onClose={handleClosed}
      onKeyDown={containFocus}
    >
      <div className="px-5 pb-5 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id={titleId} className="font-display text-2xl font-normal tracking-[-0.02em]">
              Thử đồ
            </h2>
            <span className="border border-[#3B2219]/50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#3B2219]">
              {TRY_ON_BETA_BADGE}
            </span>
          </div>
          <button
            type="button"
            className={`shrink-0 px-2 ${TEXT_BUTTON}`}
            onClick={() => dialogRef.current?.close()}
          >
            Đóng
          </button>
        </div>
        <p className="mb-3 text-xs leading-5 text-black/60">
          Xem {productName} trên ảnh của bạn. Kết quả do AI tạo, chỉ mang tính tham khảo.
        </p>
        {step === "photo" ? (
          <p className="mb-3 whitespace-pre-line border-l-[3px] border-[#3B2219]/40 bg-[#3B2219]/5 px-3 py-2 text-xs leading-5 text-black/70">
            {TRY_ON_BETA_NOTE}
          </p>
        ) : null}
        {renderProgress()}
        <div className="min-h-[24rem]">
          {step === "photo" ? renderPhotoStep() : null}
          {step === "confirm" ? renderConfirmStep() : null}
          {step === "result" ? renderResultStep() : null}
        </div>
      </div>
    </dialog>
  );
}
