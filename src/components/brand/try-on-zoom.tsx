"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { useT } from "@/i18n/client";

/**
 * A try-on picture full screen, zoomable (amendment 2026-11-09). The picture in the dialog is capped
 * so the buttons stay on screen; this is for looking at the fabric and the fit.
 *
 * A native modal `<dialog>` of its own, over the try-on dialog: the browser supplies the focus trap,
 * the inert page behind and Escape, which closes only this one. Zoom toggles between fitting the
 * screen and 2.4x. A pointer can tap or click the picture, centring on the point pressed; the same
 * toggle is a real button ("Phóng to" / "Thu nhỏ": its name is the action, so no `aria-pressed`) in the toolbar, so a keyboard or
 * a screen reader can do it too (the `<img>` itself is not focusable and is not the control). When
 * zoomed the box scrolls and takes focus, so arrow keys and a finger both pan. When the shopper's own photo is available a two-way switch shows it
 * next to the result, which is the whole "before and after" without a second screen.
 *
 * Keys are stopped here so the try-on dialog's own Tab handling does not see them through the React
 * tree, and nothing here reaches the network.
 */

const ZOOM_SCALE = 2.4;
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function BrandTryOnZoom({
  open,
  onClose,
  afterUrl,
  beforeUrl,
  alt,
  actions,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  afterUrl: string;
  /** The shopper's own photo, when it is still in memory. */
  beforeUrl: string | null;
  alt: string;
  /** Download and share, so the picture can be saved from where it is being looked at. */
  actions?: ReactNode;
}>) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    // Not the try-on dialog's to see.
    event.stopPropagation();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("Xem ảnh phóng to")}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-black/95 p-0 text-white backdrop:bg-black/95"
      // React passes `cancel` and `close` up its component tree even though the browser does not, so
      // without these the try-on dialog this one sits inside would close itself with it.
      onCancel={(event) => event.stopPropagation()}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {/* Mounted only while open, so every opening starts fitted to the screen and on the result. */}
      {open ? (
        <ZoomBody afterUrl={afterUrl} beforeUrl={beforeUrl} alt={alt} actions={actions} onClose={onClose} />
      ) : null}
    </dialog>
  );
}

function ZoomBody({
  afterUrl,
  beforeUrl,
  alt,
  actions,
  onClose,
}: Readonly<{
  afterUrl: string;
  beforeUrl: string | null;
  alt: string;
  actions?: ReactNode;
  onClose: () => void;
}>) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingCenterRef = useRef<{ x: number; y: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [showBefore, setShowBefore] = useState(false);

  // After the image has been resized, bring the pressed point to the middle of the box.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const center = pendingCenterRef.current;
    pendingCenterRef.current = null;
    if (!scroller) return;
    if (!zoomed) {
      scroller.scrollTo({ left: 0, top: 0 });
      return;
    }
    if (center) {
      scroller.scrollTo({
        left: center.x * scroller.scrollWidth - scroller.clientWidth / 2,
        top: center.y * scroller.scrollHeight - scroller.clientHeight / 2,
      });
    }
  }, [zoomed]);

  /** The toolbar button: no pointer position, so the middle of the picture. */
  function toggleZoomFromButton() {
    pendingCenterRef.current = { x: 0.5, y: 0.5 };
    setZoomed((current) => !current);
  }

  function toggleZoom(event: MouseEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pendingCenterRef.current = {
      x: rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width,
      y: rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height,
    };
    setZoomed((current) => !current);
  }

  const src = showBefore && beforeUrl ? beforeUrl : afterUrl;

  return (
    <div className="relative flex h-dvh w-screen flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {beforeUrl ? (
          <div role="group" aria-label={t("Chọn ảnh xem")} className="flex border border-white/50 text-[13px]">
            <button
              type="button"
              aria-pressed={!showBefore}
              className={`min-h-11 px-3.5 ${FOCUS_RING} ${showBefore ? "" : "bg-white text-black"}`}
              onClick={() => setShowBefore(false)}
            >
              {t("Đã thử đồ")}
            </button>
            <button
              type="button"
              aria-pressed={showBefore}
              className={`min-h-11 px-3.5 ${FOCUS_RING} ${showBefore ? "bg-white text-black" : ""}`}
              onClick={() => setShowBefore(true)}
            >
              {t("Ảnh gốc")}
            </button>
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`inline-flex min-h-11 items-center border border-white/50 bg-black/30 px-3.5 text-[13px] ${FOCUS_RING}`}
            onClick={toggleZoomFromButton}
          >
            {zoomed ? t("Thu nhỏ") : t("Phóng to")}
          </button>
          <button
            type="button"
            aria-label={t("Đóng ảnh phóng to")}
            className={`inline-flex h-11 w-11 items-center justify-center border border-white/50 bg-black/30 text-2xl ${FOCUS_RING}`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        // A zoomed picture is panned by touch, and a keyboard can scroll the box.
        tabIndex={zoomed ? 0 : -1}
        aria-label={zoomed ? t("Ảnh đang phóng to, cuộn để xem") : undefined}
      >
        <div className={zoomed ? "" : "flex h-full w-full items-center justify-center"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob; next/image cannot optimise it. */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            onClick={toggleZoom}
            style={zoomed ? { width: `${ZOOM_SCALE * 100}%`, maxWidth: "none" } : undefined}
            className={zoomed ? "block h-auto cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
          />
        </div>
      </div>

      <p className="shrink-0 px-4 pt-2 text-center text-xs text-white/70">
        {zoomed ? t("Cuộn hoặc dùng phím mũi tên để xem; chạm lần nữa để thu nhỏ") : t("Chạm vào ảnh hoặc bấm Phóng to")}
      </p>
      {actions ? (
        <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">{actions}</div>
      ) : (
        <div className="pb-[max(1rem,env(safe-area-inset-bottom))]" />
      )}
    </div>
  );
}
