"use client";

import Link from "@/i18n/link";
import { useEffect, useRef, useState } from "react";

import { tryOnElapsedLabel, tryOnWaitProgress } from "@/components/headless/try-on-model";
import { isExitIntent, isUnloadingClick, leaveOffer } from "@/components/headless/try-on-leave";
import { useTryOnSession } from "@/components/headless/try-on-session";
import { trackTryOn } from "@/components/headless/try-on-track";
import { NAVIGATION } from "@/brand";
import { useT } from "@/i18n/client";
import { STOREFRONT_PURCHASE_ANCHOR } from "@/routes/storefront-anchors";

import { useTryOnElapsedSeconds } from "./try-on-waiting";

/**
 * Keeps a shopper from losing a try-on that is still being made by leaving the page.
 *
 * What is lost is only ever lost by *unloading* the page (closing the tab, reloading, following a link
 * to another site or a plain reloading link such as the language switcher). Moving around the app does
 * not lose it: the session provider holds the job and the dock shows it. So this does nothing for
 * in-app navigation, and while a job is loading it does three things (rules in `try-on-leave.ts`):
 *
 *   1. `beforeunload`: the browser's own confirmation, for what cannot be seen coming. Its wording is
 *      the browser's, not ours.
 *   2. A click on a link that would unload the page is held back and answered with this dialog, which
 *      can offer what the browser's cannot: stay, open the link in a new tab and keep this one, or go
 *      on anyway.
 *   3. On a desktop, the pointer leaving through the top of the window gets the same dialog once per
 *      job, minus the choices that need a link, as a polite offer of something to do meanwhile (pick a
 *      size, browse on). It is a hint, never blocking: no history trap, and it is never raised again
 *      for the same job.
 *
 * Nothing is raised once the job has settled (the picture is on the dock) or while another modal is
 * open. Touch screens get only (1) and (2); there is no leaving gesture to read, and a back-button
 * trap would be the very thing that makes shoppers distrust a shop.
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]";
/**
 * The ways out are quiet on purpose: one solid button says "stay", and everything else is a line of
 * text between hairlines, so the dialog reads as an offer rather than a row of competing buttons.
 * The arrow only nudges on hover, and not at all for a shopper who asks for less motion.
 */
const ROW = `group flex min-h-12 w-full items-center justify-between gap-3 border-t border-[#3B2219]/12 py-2 text-left text-[15px] text-[#3B2219] transition-colors hover:text-black ${FOCUS_RING}`;
const ROW_ARROW =
  "text-base leading-none text-[#3B2219]/45 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#3B2219] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0";
const QUIET_TEXT = `min-h-11 px-2 text-[13px] text-black/60 underline decoration-black/25 underline-offset-4 transition-colors hover:text-black/80 ${FOCUS_RING}`;

/**
 * Where "browse other products" leads: the first entry of the main navigation, which is the shop's
 * main listing. An in-app page, so the job keeps running behind it (the dock shows it).
 */
const BROWSE_HREF = NAVIGATION.primary[0]?.href ?? "/";

type LeavePrompt = Readonly<{ href: string | null }>;
type Action = "stay" | "alt" | "exit";

export function BrandTryOnLeaveGuard() {
  const t = useT();
  const { job } = useTryOnSession();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [prompt, setPrompt] = useState<LeavePrompt | null>(null);
  // What the shopper chose in the dialog; empty when it was dismissed (Esc), which means "stay".
  const actionRef = useRef<Action | null>(null);
  // The job the exit-intent offer was already made for: one offer per job.
  const offeredForRef = useRef<number | null>(null);
  // Set when the shopper has chosen to leave, so the browser's own confirmation is not asked as well.
  const leavingRef = useRef(false);

  const loading = job?.status === "loading";
  const jobId = loading ? job.id : null;
  const productSlug = loading ? job.productSlug : null;
  const elapsed = useTryOnElapsedSeconds(loading ? job.startedAt : null);
  const open = prompt !== null && loading;

  // (1) The browser's own confirmation, only while a picture is on its way.
  useEffect(() => {
    if (jobId === null) return;
    leavingRef.current = false;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (leavingRef.current) return;
      event.preventDefault();
      // Older browsers need a value; current ones ignore the text and show their own.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [jobId]);

  // (2) Links that would unload the page, and (3) the pointer leaving through the top.
  useEffect(() => {
    if (jobId === null || productSlug === null) return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

    function raise(href: string | null) {
      actionRef.current = null;
      setPrompt({ href });
      trackTryOn({ event: "leave_prompt", productSlug: productSlug ?? undefined });
    }

    function onClick(event: MouseEvent) {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (anchor === null) return;
      const unloading = isUnloadingClick({
        href: anchor.href,
        origin: window.location.origin,
        target: anchor.getAttribute("target") ?? "",
        download: anchor.hasAttribute("download"),
        reloads: anchor.closest("[data-language-switcher]") !== null,
        button: event.button,
        modified: event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
      });
      if (!unloading) return;
      event.preventDefault();
      raise(anchor.href);
    }

    function onMouseOut(event: MouseEvent) {
      if (offeredForRef.current === jobId) return;
      if (!isExitIntent({ clientY: event.clientY, relatedTarget: event.relatedTarget, finePointer: finePointer.matches })) {
        return;
      }
      // Another modal (the try-on dialog, the cart, a zoomed picture) already has the shopper's attention.
      if (document.querySelector("dialog:modal") !== null) return;
      offeredForRef.current = jobId;
      raise(null);
    }

    // Capture, so a link is held back before the router or the browser acts on it.
    document.addEventListener("click", onClick, true);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mouseout", onMouseOut);
    };
  }, [jobId, productSlug]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function handleClosed() {
    const action = actionRef.current ?? "stay";
    actionRef.current = null;
    if (action === "stay") trackTryOn({ event: "leave_stay", productSlug: productSlug ?? undefined });
    setPrompt(null);
  }

  function choose(action: Action) {
    actionRef.current = action;
    trackTryOn({
      event: action === "stay" ? "leave_stay" : action === "alt" ? "leave_alt" : "leave_exit",
      productSlug: productSlug ?? undefined,
    });
    dialogRef.current?.close();
  }

  function openInNewTab(href: string) {
    window.open(href, "_blank", "noopener");
    choose("alt");
  }

  function leaveAnyway(href: string) {
    leavingRef.current = true;
    choose("exit");
    window.location.assign(href);
  }

  const href = prompt?.href ?? null;
  const offer = leaveOffer(href);
  const slug = productSlug ?? job?.productSlug ?? "";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="try-on-leave-title"
      className="tryon-leave m-0 mt-auto w-full max-w-none rounded-t-2xl border-0 bg-[#FAF7F2] p-0 text-black shadow-2xl backdrop:bg-black/45 sm:m-auto sm:max-w-[420px] sm:rounded-lg"
      onClose={handleClosed}
    >
      {open ? (
        <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5">
          <h2 id="try-on-leave-title" className="font-display text-2xl font-normal tracking-[-0.02em]">
            {t("Ảnh của nàng sắp xong rồi")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-black/75">
            {t("Nếu rời trang lúc này, ảnh đang tạo sẽ mất và nàng phải dùng thêm một lượt thử để tạo lại.")}
          </p>

          <div aria-hidden="true" className="mt-3 flex items-center gap-3 text-xs text-black/60">
            <span className="relative h-0.5 flex-1 bg-[#3B2219]/15">
              <span
                className="absolute inset-0 origin-left bg-[#3B2219] transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                style={{ transform: `scaleX(${tryOnWaitProgress(elapsed)})` }}
              />
            </span>
            <span>{tryOnElapsedLabel(elapsed)}</span>
          </div>

          <button
            type="button"
            // The safe choice takes focus, so a stray Enter keeps the picture.
            autoFocus
            className={`btn btn--primary mt-5 w-full px-4 ${FOCUS_RING}`}
            onClick={() => choose("stay")}
          >
            {t("Tiếp tục xem")}
          </button>

          <p className="mb-1 mt-6 text-[11px] font-medium uppercase tracking-[0.14em] text-black/60">
            {t("Trong lúc chờ, nàng có thể:")}
          </p>
          <div className="border-b border-[#3B2219]/12">
            {offer.newTab && href !== null ? (
              <button type="button" className={ROW} onClick={() => openInNewTab(href)}>
                {t("Mở liên kết ở tab mới")}
                <span aria-hidden="true" className={ROW_ARROW}>
                  ↗
                </span>
              </button>
            ) : null}
            <Link
              href={`/shop/${encodeURIComponent(slug)}#${STOREFRONT_PURCHASE_ANCHOR}`}
              className={ROW}
              onClick={() => choose("alt")}
            >
              {t("Chọn size & thêm vào giỏ")}
              <span aria-hidden="true" className={ROW_ARROW}>
                →
              </span>
            </Link>
            <Link href={BROWSE_HREF} className={ROW} onClick={() => choose("alt")}>
              {t("Xem sản phẩm khác")}
              <span aria-hidden="true" className={ROW_ARROW}>
                →
              </span>
            </Link>
          </div>
          <p className="mt-3 text-xs leading-5 text-black/60">{t("Ảnh vẫn được tạo tiếp ở góc màn hình.")}</p>

          {offer.leave && href !== null ? (
            <div className="mt-1 flex justify-center">
              <button type="button" className={QUIET_TEXT} onClick={() => leaveAnyway(href)}>
                {t("Vẫn rời trang")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
