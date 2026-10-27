"use client";

import Image from "next/image";
import { preconnect } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { createPdpVideoPlaybackReporter } from "@/components/headless/pdp-video-playback";
import type { PancakePdpVideo } from "@/commerce/pancake-pdp-video";
import { pdpProductImageLoader } from "@/components/headless/pdp-image-loader";
import { useDocumentLoaded } from "@/components/headless/use-document-loaded";
import { useInlineVideoAllowed } from "@/components/headless/use-inline-video-allowed";

function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  for (const source of video.querySelectorAll("source")) source.removeAttribute("src");
  video.load();
}

/**
 * One product-wide overlay, outside both photo tracks and their navigation hit areas.
 *
 * The frame is a 9:16 muted, looping preview that starts by itself; tapping it opens the same video
 * in a dialog with sound and controls. The preview costs the photographs nothing: the poster is an
 * optimised photograph that paints with the page, and the video is requested only once the document
 * has loaded, so it never competes with the hero image. It is left out entirely under reduced
 * motion, Data Saver or a 2G link, where the frame stays a poster and the dialog remains one tap away.
 */
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
  const preview = useRef<HTMLVideoElement>(null);
  const previewHeld = useRef(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const documentLoaded = useDocumentLoaded();
  const inlineAllowed = useInlineVideoAllowed();
  const showPreview = documentLoaded && inlineAllowed && !previewFailed;

  // The connection (DNS, TLS) is warm by the time the preview asks for its first bytes.
  preconnect(new URL(video.src).origin);

  // The preview runs only while it is on screen and the dialog is not holding the shopper's attention.
  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !previewHeld.current) void element.play().catch(() => undefined);
      else element.pause();
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => {
      observer.disconnect();
      releaseVideo(element);
    };
  }, [showPreview]);

  function failPreview() {
    releaseVideo(preview.current);
    setPreviewPlaying(false);
    setPreviewFailed(true);
  }

  // Also stop an active player when navigation or refreshed server props remove the overlay.
  useEffect(() => {
    const element = player.current;
    return () => {
      reporting.close();
      releaseVideo(element);
    };
  }, [requested, video.src, reporting]);

  // The shopper's tap is the request to play, so it plays at once. An explicit `play()` rather than
  // the `autoplay` attribute: it raises `play` immediately, which starts the startup deadline even
  // when the first byte never arrives.
  useEffect(() => {
    if (requested) void player.current?.play().catch(() => undefined);
  }, [requested]);

  function close() {
    reporting.close();
    releaseVideo(player.current);
    setRequested(false);
    dialog.current?.close();
    opener.current?.focus({ preventScroll: true });
    previewHeld.current = false;
    void preview.current?.play().catch(() => undefined);
  }

  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-haspopup="dialog"
        className="pdp-video-tile"
        onClick={() => {
          setReporting(createPdpVideoPlaybackReporter(undefined, () => {
            setFailed(true);
            releaseVideo(player.current);
          }));
          setFailed(false);
          setRequested(true);
          previewHeld.current = true;
          preview.current?.pause();
          dialog.current?.showModal();
        }}
      >
        <Image loader={pdpProductImageLoader} src={video.poster} alt="" fill sizes="120px" className="object-cover" />
        {showPreview ? (
          <video
            ref={preview}
            src={video.src}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            aria-hidden="true"
            tabIndex={-1}
            className="pdp-video-tile__preview"
            data-playing={previewPlaying ? "true" : "false"}
            onLoadedMetadata={(event) => {
              // An HEVC track some browsers discard leaves a running clock and no picture.
              const element = event.currentTarget;
              if (element.videoWidth === 0 || element.videoHeight === 0) failPreview();
            }}
            onPlaying={() => setPreviewPlaying(true)}
            onPause={() => setPreviewPlaying(false)}
            onError={failPreview}
          />
        ) : null}
        <span className="pdp-video-tile__label">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
          Xem video
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="pointer-events-auto m-auto max-h-[92dvh] w-[92vw] max-w-md overflow-y-auto border-0 bg-[#FAF7F2] p-4 text-[#3B2219] shadow-2xl backdrop:bg-black/60"
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={() => { if (!dialog.current?.open) close(); }}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold">Video {productName}</h2>
          <button type="button" className="min-h-11 min-w-11 px-2 underline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={close}>Đóng</button>
        </div>
        {requested ? (
          <video ref={player} controls playsInline preload="none" poster={video.poster} tabIndex={0} aria-label={`Video ${productName}`} className="mx-auto block aspect-[9/16] h-[min(78dvh,720px)] max-w-full bg-black object-contain" onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            // Some browsers accept an HEVC container's AAC track but silently discard the video.
            // A running audio clock is not evidence that the shopper can see a product video.
            if (element.videoWidth === 0 || element.videoHeight === 0) reporting.error(4);
          }} onPlay={() => reporting.play()}
            onPlaying={() => reporting.playing()}
            onWaiting={(event) => { if (!event.currentTarget.paused && !event.currentTarget.ended && event.currentTarget.readyState < 3) reporting.waiting(); }}
            onStalled={(event) => { if (!event.currentTarget.paused && !event.currentTarget.ended && event.currentTarget.readyState < 3) reporting.waiting(); }}
            onPause={() => reporting.pause()}
            onEnded={() => reporting.pause()}
            onError={() => { reporting.error(player.current?.error?.code); }}>
            <source src={video.src} type="video/mp4" onError={() => { reporting.error(player.current?.error?.code); }} />
          </video>
        ) : null}
        {failed ? <p role="alert" className="mt-3 text-sm">Chưa phát được video. Nàng có thể đóng để xem ảnh và tiếp tục mua hàng.</p> : null}
      </dialog>
    </>
  );
}
