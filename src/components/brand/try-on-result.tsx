"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

import { TRY_ON_TEEN_DISCLOSURE } from "@/components/headless/try-on-model";
import type { TryOnResult } from "@/components/headless/try-on-session";
import { canShareTryOnFiles, shareTryOnImage, tryOnResultFileName } from "@/components/headless/try-on-share";
import { trackTryOn } from "@/components/headless/try-on-track";
import type { TryOnRating } from "@/commerce/try-on-client-events";

import { BrandTryOnZoom } from "./try-on-zoom";

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]";

/** Whether this browser can share image files; false on the server and until mounted. */
export function useCanShareTryOnFiles(): boolean {
  // A browser capability that never changes: read on the client, `false` while rendering on the server
  // and during hydration, so the two agree.
  return useSyncExternalStore(subscribeNever, canShareTryOnFiles, () => false);
}

function subscribeNever(): () => void {
  return () => undefined;
}

/**
 * The save buttons: download always, share where the browser can. The picture is the answer to the shopper's question, so it is the first thing in the step and the
 * only thing that may grow: pressing it (or "Phóng to") opens it full screen, where it can be zoomed
 * and set against their own photo.
 */
export function BrandTryOnSaveActions({
  result,
  productName,
  productSlug,
  canShare,
  className,
}: Readonly<{
  result: TryOnResult;
  productName: string;
  productSlug: string;
  canShare: boolean;
  className: string;
}>) {
  const [sharing, setSharing] = useState(false);
  return (
    <>
      <a
        href={result.url}
        download={tryOnResultFileName(productSlug, result.mimeType)}
        className={className}
        onClick={() => trackTryOn({ event: "download", productSlug })}
      >
        Tải ảnh
      </a>
      {canShare ? (
        <button
          type="button"
          className={className}
          disabled={sharing}
          onClick={async () => {
            setSharing(true);
            const outcome = await shareTryOnImage({
              url: result.url,
              mimeType: result.mimeType,
              productSlug,
              productName,
            });
            setSharing(false);
            if (outcome === "shared") trackTryOn({ event: "share", productSlug });
          }}
        >
          Chia sẻ
        </button>
      ) : null}
    </>
  );
}

/**
 * "Was this any good?" under the picture: the one signal that says whether the quality is worth the
 * cost. A thumb is counted (`try-on-client-events.ts`), never the picture or any words; it can be
 * changed until the shopper leaves, and a new picture asks again (the caller keys it by the picture).
 */
function Feedback({ productSlug }: Readonly<{ productSlug: string }>) {
  const [rating, setRating] = useState<TryOnRating | null>(null);

  function choose(next: TryOnRating) {
    if (next === rating) return;
    setRating(next);
    trackTryOn({ event: "feedback", productSlug, rating: next });
  }

  const button = (value: TryOnRating, emoji: string, label: string) => (
    <button
      type="button"
      aria-pressed={rating === value}
      className={`flex min-h-11 items-center gap-1.5 rounded-full border border-[#3B2219]/40 px-3.5 text-[13px] ${FOCUS_RING} ${
        rating === value ? "bg-[#3B2219] text-[#FAF7F2]" : "bg-white/50 text-[#3B2219]"
      }`}
      onClick={() => choose(value)}
    >
      <span aria-hidden="true">{emoji}</span>
      {label}
    </button>
  );

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/10 pt-3" role="group" aria-label="Đánh giá ảnh thử đồ">
      <span className="mr-1 text-[13px] text-black/75">Ảnh này thế nào?</span>
      {button("up", "👍", "Giống thật")}
      {button("down", "👎", "Chưa ổn")}
      <span aria-live="polite" className="w-full text-xs leading-5 text-black/60">
        {rating === null ? "" : "Cảm ơn nàng, La.na sẽ dùng góp ý này để làm ảnh tốt hơn."}
      </span>
    </div>
  );
}

/**
 * A finished try-on picture with what must always travel with it: the download, the statement that
 * it is an AI picture for reference only, and for a teen attestation the disclosure as well. Shared
 * by the PDP dialog and the viewer the dock opens on other pages, so neither can show the picture
 * without them. The step's main action (choose a size) is the caller's, in its sticky footer.
 */
export function BrandTryOnResult({
  result,
  productName,
  productSlug,
  isTeen,
  secondaryAction,
  beforeUrl = null,
}: Readonly<{
  result: TryOnResult;
  productName: string;
  productSlug: string;
  isTeen: boolean;
  /** Beside the download: "Tạo lại" in the dialog, "Xem sản phẩm" elsewhere. */
  secondaryAction: ReactNode;
  /** The shopper's own photo, when still in memory, for the before/after switch in the zoom. */
  beforeUrl?: string | null;
}>) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const canShare = useCanShareTryOnFiles();

  const alt = `Ảnh thử đồ do AI tạo cho ${productName}, chỉ mang tính tham khảo`;
  const actionClass = "btn btn--outline px-3";

  function openZoom() {
    trackTryOn({ event: "zoom", productSlug });
    setZoomOpen(true);
  }

  return (
    <>
      <div className="relative mx-auto mt-2 w-fit max-w-full">
        <button
          type="button"
          aria-label="Phóng to ảnh thử đồ"
          className={`block cursor-zoom-in ${FOCUS_RING}`}
          onClick={openZoom}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob; next/image cannot optimise it. */}
          <img src={result.url} alt={alt} className="max-h-[22rem] w-auto max-w-full border border-black/15 object-contain" />
        </button>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 right-2 bg-[#FAF7F2]/90 px-2 py-1 text-[11px] font-semibold text-[#3B2219]"
        >
          Phóng to
        </span>
      </div>
      <div className={`mt-3 grid gap-2 ${canShare ? "grid-cols-3" : "grid-cols-2"}`}>
        <BrandTryOnSaveActions
          result={result}
          productName={productName}
          productSlug={productSlug}
          canShare={canShare}
          className={actionClass}
        />
        {secondaryAction}
      </div>
      <Feedback key={result.url} productSlug={productSlug} />
      <p className="mt-3 text-xs leading-5 text-black/65">
        Ảnh do AI tạo, chỉ mang tính tham khảo — không đảm bảo kích cỡ, độ vừa vặn, chất liệu hay màu
        sắc thật.
      </p>
      {isTeen ? (
        <p className="mt-2 border-l-[3px] border-[#3B2219] pl-3 text-xs leading-5 text-black/75">
          {TRY_ON_TEEN_DISCLOSURE}
        </p>
      ) : null}

      <BrandTryOnZoom
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        afterUrl={result.url}
        beforeUrl={beforeUrl}
        alt={alt}
        actions={
          <div className={`grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
            <BrandTryOnSaveActions
              result={result}
              productName={productName}
              productSlug={productSlug}
              canShare={canShare}
              className="btn btn--outline border-white/60 px-3 text-white hover:text-black"
            />
          </div>
        }
      />
    </>
  );
}
