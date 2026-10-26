"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { createPdpVideoPlaybackReporter } from "@/components/headless/pdp-video-playback";
import type { PancakePdpVideo } from "@/commerce/pancake-pdp-video";
import { pdpProductImageLoader } from "@/components/headless/pdp-image-loader";

function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  for (const source of video.querySelectorAll("source")) source.removeAttribute("src");
  video.load();
}

/** One product-wide overlay, outside both photo tracks and their navigation hit areas. */
export function BrandProductVideoOverlay({ video, productName }: Readonly<{
  video: PancakePdpVideo;
  productName: string;
}>) {
  const titleId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [reporting, setReporting] = useState(() => createPdpVideoPlaybackReporter());
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);

  // Also stop an active player when navigation or refreshed server props remove the overlay.
  useEffect(() => {
    const element = player.current;
    return () => {
      reporting.close();
      releaseVideo(element);
    };
  }, [requested, video.src, reporting]);

  function close() {
    reporting.close();
    releaseVideo(player.current);
    setRequested(false);
    dialog.current?.close();
    opener.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-haspopup="dialog"
        className="pdp-video-tile"
        onClick={() => {
          setReporting(createPdpVideoPlaybackReporter());
          setFailed(false);
          setRequested(true);
          dialog.current?.showModal();
        }}
      >
        <Image loader={pdpProductImageLoader} src={video.poster} alt="" fill sizes="96px" className="object-cover" />
        <span className="pdp-video-tile__label">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
          Xem video
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="pointer-events-auto m-auto max-h-[92dvh] w-[92vw] max-w-3xl overflow-y-auto border-0 bg-[#FAF7F2] p-4 text-[#3B2219] shadow-2xl backdrop:bg-black/60"
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={() => { if (!dialog.current?.open) close(); }}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold">Video {productName}</h2>
          <button type="button" className="min-h-11 min-w-11 px-2 underline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={close}>Đóng</button>
        </div>
        {requested ? (
          <video ref={player} controls playsInline preload="none" poster={video.poster} tabIndex={0} aria-label={`Video ${productName}`} className="max-h-[70dvh] w-full bg-black" onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            // Some browsers accept an HEVC container's AAC track but silently discard the video.
            // A running audio clock is not evidence that the shopper can see a product video.
            if ((element.videoWidth === 0 || element.videoHeight === 0) && reporting.error(4)) {
              setFailed(true);
              releaseVideo(element);
            }
          }} onPlay={() => reporting.play()} onError={() => { if (reporting.error(player.current?.error?.code)) setFailed(true); }}>
            <source src={video.src} type="video/mp4" onError={() => { if (reporting.error(player.current?.error?.code)) setFailed(true); }} />
          </video>
        ) : null}
        {failed ? <p role="alert" className="mt-3 text-sm">Chưa phát được video. Nàng có thể đóng để xem ảnh và tiếp tục mua hàng.</p> : null}
      </dialog>
    </>
  );
}
