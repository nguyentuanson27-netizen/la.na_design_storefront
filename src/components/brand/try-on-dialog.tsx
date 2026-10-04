"use client";

import { useId, useRef, type KeyboardEvent } from "react";

import { BRAND } from "@/brand";
import {
  TRY_ON_AGE_OPTIONS,
  TRY_ON_BLOCKED_AGE_MESSAGE,
  TRY_ON_LIKENESS_ACKNOWLEDGEMENT,
  TRY_ON_TEEN_DISCLOSURE,
} from "@/components/headless/try-on-model";
import { useTryOn } from "@/components/headless/use-try-on";

/**
 * Virtual try-on on the PDP (`docs/specs/storefront-virtual-try-on.md` §6, §13, §14).
 *
 * Markup and focus only. The photo, the attestations, the request and the result are
 * `useTryOn`'s; this file decides how they look. It shares nothing with the purchase panel, so the
 * dialog can fail or be dismissed without touching the cart or the variant selection.
 *
 * A native modal `<dialog>` supplies the focus trap, the inert page behind it and Escape; closing it
 * by any route runs one handler that drops the photo and the result and returns focus to the
 * trigger.
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

export function BrandTryOnLauncher({
  productSlug,
  productName,
}: Readonly<{ productSlug: string; productName: string }>) {
  const ids = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tryOn = useTryOn({ productSlug, fileInputRef });

  function openDialog() {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }

  // Runs for Escape, the close button and `dialog.close()` alike.
  function handleClosed() {
    tryOn.reset();
    triggerRef.current?.focus();
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
  const hintId = `${ids}-hint`;
  const { phase, result } = tryOn;
  const showHint = !tryOn.canGenerate && !tryOn.isBlockedAge && phase !== "loading";

  return (
    <div className="mt-3">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--outline w-full px-4"
        aria-haspopup="dialog"
        onClick={openDialog}
      >
        Thử đồ
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        tabIndex={-1}
        className="m-auto max-h-dvh w-full max-w-xl overflow-y-auto border-0 bg-[#FAF7F2] p-0 text-black shadow-2xl backdrop:bg-black/45 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]"
        onClose={handleClosed}
        onKeyDown={containFocus}
      >
        <div className="px-5 pb-6 pt-4 sm:px-8">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="font-display text-2xl font-normal tracking-[-0.02em]">
              Thử đồ
            </h2>
            <button
              type="button"
              className="min-h-11 shrink-0 px-2 text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
              onClick={() => dialogRef.current?.close()}
            >
              Đóng
            </button>
          </div>

          <p className="mt-2 text-sm leading-6 text-black/70">
            Tải lên một ảnh của bạn để xem {productName} trên ảnh đó.
          </p>
          <p className="mt-2 text-sm leading-6 text-black/70">
            Ảnh do AI tạo ra chỉ mang tính tham khảo, không đảm bảo kích cỡ, độ vừa vặn, chất liệu,
            màu sắc chính xác hay hình ảnh thực tế của sản phẩm. Hãy xem bảng size để chọn kích cỡ.
          </p>

          <div className="mt-5">
            <label htmlFor={`${ids}-photo`} className="block text-sm font-semibold">
              Ảnh của bạn (JPG hoặc PNG, tối đa 7 MB)
            </label>
            <p id={fileHelpId} className="mt-1 text-sm text-black/65">
              Dùng ảnh chính diện, thấy rõ người, đủ sáng; tránh ảnh quá nhỏ hoặc bị che nhiều.
            </p>
            {/* The native control reads "Choose File / No file chosen" in the browser's language, so
                it is kept for keyboard, screen-reader and file-picker behaviour but hidden, and a
                Vietnamese label draws the button. `peer` carries its focus ring onto that label. */}
            <div className="mt-2 flex min-h-11 items-center gap-3">
              <input
                ref={fileInputRef}
                id={`${ids}-photo`}
                type="file"
                accept="image/jpeg,image/png"
                className="peer sr-only"
                aria-describedby={tryOn.fileError ? `${fileHelpId} ${fileErrorId}` : fileHelpId}
                aria-invalid={tryOn.fileError ? "true" : undefined}
                onChange={tryOn.chooseFile}
              />
              <label
                htmlFor={`${ids}-photo`}
                className="btn btn--outline shrink-0 cursor-pointer px-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#3B2219]"
              >
                Chọn ảnh
              </label>
              <span className="min-w-0 truncate text-sm text-black/70">{tryOn.fileName ?? "Chưa chọn ảnh"}</span>
            </div>
            {tryOn.fileError ? (
              <p id={fileErrorId} role="alert" className={`mt-2 text-sm font-semibold ${ERROR_TEXT}`}>
                {tryOn.fileError}
              </p>
            ) : null}
            {tryOn.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local blob preview; next/image cannot optimise it.
              <img
                src={tryOn.previewUrl}
                alt="Ảnh bạn đã chọn"
                className="mt-3 max-h-64 w-auto max-w-full border border-black/15 object-contain"
              />
            ) : null}
          </div>

          <fieldset className="mt-5">
            <legend className="text-sm font-semibold">Độ tuổi của bạn</legend>
            <div className="mt-2 space-y-1">
              {TRY_ON_AGE_OPTIONS.map((option) => (
                <label key={option.value} className="flex min-h-11 items-start gap-3 py-2 text-sm leading-5">
                  <input
                    type="radio"
                    name={`${ids}-age`}
                    value={option.value}
                    checked={tryOn.ageState === option.value}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[#3B2219]"
                    onChange={() => tryOn.setAgeState(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            {tryOn.isBlockedAge ? (
              <p role="alert" className={`mt-2 text-sm font-semibold ${ERROR_TEXT}`}>
                {TRY_ON_BLOCKED_AGE_MESSAGE}
              </p>
            ) : null}
            {tryOn.isTeen ? (
              <p className="mt-2 border-l-2 border-[#3B2219] pl-3 text-sm leading-6 text-black/75">
                {TRY_ON_TEEN_DISCLOSURE}
              </p>
            ) : null}
          </fieldset>

          <label className="mt-4 flex min-h-11 items-start gap-3 py-2 text-sm leading-5">
            <input
              type="checkbox"
              checked={tryOn.acknowledged}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[#3B2219]"
              onChange={(event) => tryOn.setAcknowledged(event.target.checked)}
            />
            <span>{TRY_ON_LIKENESS_ACKNOWLEDGEMENT}</span>
          </label>

          <p className="mt-3 text-xs leading-5 text-black/60">
            {BRAND.identity.name} không lưu ảnh bạn tải lên hay ảnh được tạo trong hệ thống của chúng
            tôi. Ảnh của bạn và ảnh sản phẩm được gửi tới Google Cloud Vertex AI để tạo kết quả; việc xử
            lý và lưu giữ tại Google Cloud tuân theo các thiết lập kiểm soát dữ liệu và điều khoản dịch
            vụ áp dụng.
          </p>

          <button
            type="button"
            className="btn btn--primary mt-4 w-full px-4"
            disabled={!tryOn.canGenerate}
            aria-busy={phase === "loading"}
            aria-describedby={showHint ? hintId : undefined}
            onClick={tryOn.generate}
          >
            {phase === "success" ? "Tạo lại" : "Tạo ảnh thử đồ"}
          </button>
          {showHint ? (
            <p id={hintId} className="mt-2 text-xs text-black/60">
              Để tạo ảnh, hãy {tryOn.missingSteps.join(", ")}.
            </p>
          ) : null}

          <div className="mt-3 min-h-6" role="status" aria-live="polite">
            {phase === "loading" ? "Đang tạo ảnh thử đồ, vui lòng chờ trong giây lát…" : null}
            {phase === "success" ? "Đã tạo xong ảnh thử đồ." : null}
          </div>

          {phase === "error" && tryOn.errorMessage ? (
            <p role="alert" className={`mt-1 text-sm font-semibold ${ERROR_TEXT}`}>
              {tryOn.errorMessage}
            </p>
          ) : null}

          {phase === "success" && result ? (
            <div className="mt-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob; next/image cannot optimise it. */}
              <img
                src={result.url}
                alt={`Ảnh thử đồ do AI tạo cho ${productName}, chỉ mang tính tham khảo`}
                className="max-h-[28rem] w-auto max-w-full border border-black/15 object-contain"
              />
              <a
                href={result.url}
                download={`thu-do-${productSlug}.${result.mimeType === "image/png" ? "png" : "jpg"}`}
                className="btn btn--outline mt-3 w-full px-4"
              >
                Tải ảnh
              </a>
            </div>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
