"use client";
import { useEffect, useId, useRef, useState } from "react";

/** Native modal supplies inert background and focus containment, including Escape. */
export function CheckoutGiftReminderDialog({ open, disabled, description, canChoose, onShown, onClose, onChoose, onContinue }: Readonly<{
  open: boolean; disabled: boolean; description: string; canChoose: boolean;
  onShown: () => void; onClose: () => void; onChoose: () => void; onContinue: () => void;
}>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setArmed(true), 350);
    return () => { clearTimeout(timer); setArmed(false); };
  }, [open]);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal(); heading.current?.focus(); onShown();
    } else if (!open && dialog.current?.open) dialog.current.close();
  }, [open, onShown]);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(e) => { e.preventDefault(); onClose(); }} className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto border border-black/25 bg-[#fcf8f6] p-5 text-[#30251f] backdrop:bg-black/45 sm:p-7" onKeyDown={(event) => { if (event.key === "Enter" && (event.repeat || event.target === heading.current)) event.preventDefault(); }}>
    <h2 id={titleId} ref={heading} tabIndex={-1} className="font-display text-2xl">{canChoose ? "Bạn còn quà chưa chọn" : "Một phần quà chưa thể nhận"}</h2>
    <p id={descriptionId} className="mt-4 text-sm leading-6">{description} Bạn vẫn có thể tiếp tục đặt hàng. Quà đã lưu được giữ nguyên.</p>
    <div className="mt-5 flex flex-col gap-3">
      {canChoose ? <button type="button" className="btn btn--primary min-h-11" onClick={onChoose}>Chọn quà ngay</button> : null}
      <button type="button" className="btn btn--secondary min-h-11" disabled={disabled || !armed} onClick={onContinue}>Vẫn đặt hàng</button>
      <button type="button" className="min-h-11 text-sm underline" onClick={onClose}>Đóng lời nhắc</button>
    </div>
  </dialog>;
}
