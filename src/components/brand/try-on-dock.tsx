"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  TRY_ON_WAIT_NOTE,
  isTeenAgeState,
  tryOnElapsedLabel,
  tryOnWaitProgress,
} from "@/components/headless/try-on-model";
import { useTryOnSession, type TryOnJob } from "@/components/headless/try-on-session";

import { BrandTryOnResult } from "./try-on-result";
import { BrandTryOnWaiting, useTryOnElapsedSeconds } from "./try-on-waiting";

/**
 * The try-on the shopper started, minimised: a small card bottom left on every page while the picture
 * is being made, and until they have looked at it.
 *
 * It is what lets the shopper close the dialog and keep browsing. While the job loads it shows their
 * photo, the time waited and a thin bar; when the job settles it says so (and `role="status"`
 * announces it once). Pressing it shows the job where it belongs: the product's own dialog when the
 * shopper is on that product's page, otherwise the viewer below. A settled job can be discarded from
 * here; a loading one cannot, because its attempt is already spent and the picture is on its way.
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]";
const TEXT_BUTTON = `min-h-11 text-sm font-semibold underline underline-offset-4 ${FOCUS_RING}`;

function productHref(job: TryOnJob): string {
  return `/shop/${encodeURIComponent(job.productSlug)}`;
}

function announcement(job: TryOnJob): string {
  if (job.status === "loading") return `Đang tạo ảnh thử đồ cho ${job.productName}.`;
  if (job.status === "success") return `Ảnh thử đồ cho ${job.productName} đã xong.`;
  return `Chưa tạo được ảnh thử đồ cho ${job.productName}.`;
}

export function BrandTryOnDock() {
  const session = useTryOnSession();
  const { job, discard, markSeen, openJob } = session;
  const viewerRef = useRef<HTMLDialogElement | null>(null);
  // Set when the shopper leaves the viewer for the product page: the job goes with them, unseen or not.
  const keepOnCloseRef = useRef(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const elapsed = useTryOnElapsedSeconds(job?.status === "loading" ? job.startedAt : null);

  useEffect(() => {
    const dialog = viewerRef.current;
    if (!dialog) return;
    if (viewerOpen && !dialog.open) dialog.showModal();
    if (!viewerOpen && dialog.open) dialog.close();
  }, [viewerOpen]);

  const viewingOutcome = viewerOpen && job !== null && job.status !== "loading";
  useEffect(() => {
    if (viewingOutcome && job && !job.seen) markSeen(job.id);
  }, [viewingOutcome, job, markSeen]);

  function handleViewerClosed() {
    setViewerOpen(false);
    const keep = keepOnCloseRef.current;
    keepOnCloseRef.current = false;
    // An outcome the shopper has looked at goes when they close it, as the dialog has always done.
    if (!keep && job !== null && job.status !== "loading") discard(job.id);
  }

  function leaveForProduct() {
    keepOnCloseRef.current = true;
    viewerRef.current?.close();
  }

  const loading = job?.status === "loading";
  const thumbnail = job === null ? null : job.result?.url ?? job.photoUrl;

  return (
    <>
      {job === null ? null : (
        <div className={`tryon-dock ${loading ? "" : "tryon-dock--ready"}`} data-testid="try-on-dock">
          <p role="status" className="sr-only">
            {announcement(job)}
          </p>
          <div className="relative flex items-stretch border border-[#3B2219] bg-[#FAF7F2] shadow-[0_4px_16px_rgba(0,0,0,0.14)]">
            <button
              type="button"
              aria-haspopup="dialog"
              className={`flex min-h-11 min-w-0 items-center gap-2.5 py-1.5 pl-1.5 pr-3 text-left text-[#3B2219] ${FOCUS_RING}`}
              onClick={(event) => openJob(event.currentTarget, () => setViewerOpen(true))}
            >
              {thumbnail ? (
                <span
                  className={`tryon-dock__thumb h-11 w-9 shrink-0 border border-black/10 ${loading ? "tryon-dock__thumb--loading" : ""}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob; next/image cannot optimise it. */}
                  <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                </span>
              ) : null}
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-5">
                  {loading
                    ? "Đang tạo ảnh thử đồ"
                    : job.status === "success"
                      ? "Ảnh thử đồ đã xong"
                      : "Chưa tạo được ảnh"}
                </span>
                <span className="block truncate text-xs leading-4 text-black/60">
                  {loading ? (
                    <>
                      <span aria-hidden="true">{tryOnElapsedLabel(elapsed)} · </span>
                      Bấm để xem
                    </>
                  ) : job.status === "success" ? (
                    "Bấm để xem ảnh"
                  ) : (
                    "Bấm để xem chi tiết"
                  )}
                </span>
              </span>
            </button>
            {loading ? null : (
              <button
                type="button"
                aria-label="Bỏ ảnh thử đồ"
                className={`min-h-11 min-w-11 shrink-0 border-l border-[#3B2219]/20 text-lg leading-none text-[#3B2219]/70 ${FOCUS_RING}`}
                onClick={() => discard(job.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
            {loading ? (
              <span aria-hidden="true" className="tryon-dock__bar">
                <span style={{ transform: `scaleX(${tryOnWaitProgress(elapsed)})` }} />
              </span>
            ) : null}
          </div>
        </div>
      )}

      <dialog
        ref={viewerRef}
        aria-label="Ảnh thử đồ"
        className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border-0 bg-[#FAF7F2] p-0 text-black shadow-2xl backdrop:bg-black/45 sm:m-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-[440px] sm:rounded-lg"
        onClose={handleViewerClosed}
      >
        {viewerOpen && job !== null ? (
          <div className="px-5 pb-5 pt-4">
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-2xl font-normal tracking-[-0.02em]">Thử đồ</h2>
              <button type="button" className={`shrink-0 px-2 ${TEXT_BUTTON}`} onClick={() => viewerRef.current?.close()}>
                Đóng
              </button>
            </div>
            <p className="mb-3 text-xs leading-5 text-black/60">
              {job.productName}. Kết quả do AI tạo, chỉ mang tính tham khảo.
            </p>

            {job.status === "loading" ? (
              <>
                <p className="text-sm">Đang tạo ảnh thử đồ cho bạn…</p>
                <p className="mt-1 text-sm text-black/70">{TRY_ON_WAIT_NOTE}</p>
                <BrandTryOnWaiting photoUrl={job.photoUrl} startedAt={job.startedAt} />
                <button type="button" className="btn btn--outline mt-4 w-full px-4" onClick={() => viewerRef.current?.close()}>
                  Xem tiếp trong lúc chờ
                </button>
              </>
            ) : null}

            {job.status === "success" && job.result ? (
              <BrandTryOnResult
                result={job.result}
                productName={job.productName}
                productSlug={job.productSlug}
                isTeen={isTeenAgeState(job.ageState)}
                secondaryAction={
                  <Link href={productHref(job)} className="btn btn--outline px-4" onClick={leaveForProduct}>
                    Xem sản phẩm
                  </Link>
                }
              />
            ) : null}

            {job.status === "error" ? (
              <>
                <p role="alert" className="mt-2 text-sm font-semibold text-[#8a1c1c]">
                  {job.errorMessage}
                </p>
                <Link href={productHref(job)} className="btn btn--outline mt-4 w-full px-4" onClick={leaveForProduct}>
                  Về trang sản phẩm
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
