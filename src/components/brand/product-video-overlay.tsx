"use client";

import Image from "next/image";
import { flushSync, preconnect } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { createPdpVideoPlaybackReporter } from "@/components/headless/pdp-video-playback";
import type { PancakePdpVideo } from "@/commerce/pancake-pdp-video";
import { pdpProductImageLoader } from "@/components/headless/pdp-image-loader";
import { useDocumentLoaded } from "@/components/headless/use-document-loaded";
import { useInlineVideoAllowed, useVideoLayout } from "@/components/headless/use-inline-video-allowed";

/** A preview that is less than this much on screen stands still. */
const PREVIEW_MIN_VISIBLE_RATIO = 0.25;

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
 * The frame is a 9:16 muted, looping preview that starts by itself: on the photograph below `lg`, a
 * floating mini-player pinned to the viewport's bottom right from `lg` while the photographs are in
 * view (scrolling on to the purchase panel docks it back onto the photograph). At every width a
 * close button on its corner stops the preview (WCAG 2.2.2) and leaves the poster, which stays
 * stopped through opening and closing the dialog. Tapping the frame opens the same video in a dialog with
 * sound and controls, which carries on from the second the preview had reached rather than
 * restarting, and hands the second it left off at back to the preview. The preview costs the photographs nothing: the poster is an
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
  const layout = useVideoLayout();
  const floatingLayout = layout === "float";
  const [stopped, setStopped] = useState(false);
  const resumeAt = useRef(0);
  const [galleryInView, setGalleryInView] = useState(true);
  const floating = floatingLayout && documentLoaded && inlineAllowed && !previewFailed && !stopped && galleryInView;
  const showPreview = documentLoaded && inlineAllowed && !previewFailed && !stopped && layout !== "dock";

  // The connection (DNS, TLS) is warm by the time the preview asks for its first bytes.
  preconnect(new URL(video.src).origin);

  // The preview runs only while at least a quarter of it is on screen and the dialog is not holding
  // the shopper's attention. The observer is the one controller: it keeps whether the preview is
  // visible enough, and anything that wants to resume it (closing the dialog) asks that answer.
  const previewVisible = useRef(false);
  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      previewVisible.current = !!entry && entry.intersectionRatio >= PREVIEW_MIN_VISIBLE_RATIO;
      if (previewVisible.current && !previewHeld.current) void element.play().catch(() => undefined);
      else element.pause();
    }, { threshold: [0, PREVIEW_MIN_VISIBLE_RATIO] });
    observer.observe(element);
    return () => {
      observer.disconnect();
      previewVisible.current = false;
      releaseVideo(element);
      // A replacement preview has not painted a frame, even if this instance had been playing.
      setPreviewPlaying(false);
    };
  }, [showPreview]);

  // The mini-player floats while the photographs are being looked at and docks back onto them once
  // the shopper scrolls on towards the purchase panel, which is where it would otherwise sit over the
  // price and the buy buttons.
  useEffect(() => {
    if (!floatingLayout) return;
    const gallery = opener.current?.closest(".pdp-stage");
    if (!gallery) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setGalleryInView(gallery.getBoundingClientRect().bottom >= window.innerHeight * 0.75);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [floatingLayout]);

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

  const [blocked, setBlocked] = useState(false);

  // The shopper's tap is the request to play, so it plays at once, from where the preview was. An
  // explicit `play()` rather than the `autoplay` attribute: it raises `play` immediately, which
  // starts the startup deadline even when the first byte never arrives.
  function startDialogPlayback(element: HTMLVideoElement) {
    // Set before any data: the browser applies it as the start position once the metadata is in.
    if (resumeAt.current > 0) element.currentTime = resumeAt.current;
    void Promise.resolve(element.play()).catch((error: unknown) => {
      // A browser that refuses sound without a gesture of its own (Safari/iOS) leaves the player
      // paused on its controls: say so rather than showing a player that looks stuck.
      if (error instanceof DOMException && error.name === "NotAllowedError") setBlocked(true);
    });
  }

  function close() {
    const watched = player.current;
    if (preview.current && watched && !watched.ended && watched.currentTime > 0) {
      preview.current.currentTime = watched.currentTime;
    }
    reporting.close();
    releaseVideo(player.current);
    setRequested(false);
    dialog.current?.close();
    opener.current?.focus({ preventScroll: true });
    previewHeld.current = false;
    if (previewVisible.current) void preview.current?.play().catch(() => undefined);
  }

  return (
    <div className="pdp-video-slot" data-float={floating ? "true" : "false"}>
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
          resumeAt.current = preview.current?.currentTime ?? 0;
          previewHeld.current = true;
          preview.current?.pause();
          // Mount the player synchronously so `play()` below still runs inside this tap: browsers
          // that gate sound on a user gesture do not count a call made from a later effect.
          flushSync(() => {
            setFailed(false);
            setBlocked(false);
            setRequested(true);
          });
          dialog.current?.showModal();
          if (player.current) startDialogPlayback(player.current);
        }}
      >
        <Image loader={pdpProductImageLoader} src={video.poster} alt="" fill sizes="120px" className="object-cover" />
        {showPreview ? (
          <video
            ref={preview}
            src={video.src}
            muted
            loop
            playsInline
            preload="none"
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
      {showPreview && (layout === "phone" || floating) ? (
        <button
          type="button"
          className="pdp-video-slot__close"
          aria-label="Đóng video nhỏ"
          onClick={() => {
            setStopped(true);
            opener.current?.focus({ preventScroll: true });
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      ) : null}
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
          <video ref={player} controls playsInline preload="none" poster={video.poster} tabIndex={0} aria-label={`Video ${productName}`} className="mx-auto block aspect-[9/16] h-auto w-[min(100%,calc(min(78dvh,720px)*9/16))] bg-black object-contain" onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            // Some browsers accept an HEVC container's AAC track but silently discard the video.
            // A running audio clock is not evidence that the shopper can see a product video.
            if (element.videoWidth === 0 || element.videoHeight === 0) reporting.error(4);
          }} onPlay={() => { setBlocked(false); reporting.play(); }}
            onPlaying={() => reporting.playing()}
            onWaiting={(event) => { if (!event.currentTarget.paused && !event.currentTarget.ended && event.currentTarget.readyState < 3) reporting.waiting(); }}
            onStalled={(event) => { if (!event.currentTarget.paused && !event.currentTarget.ended && event.currentTarget.readyState < 3) reporting.waiting(); }}
            onPause={() => reporting.pause()}
            onEnded={() => reporting.pause()}
            onError={() => { reporting.error(player.current?.error?.code); }}>
            <source src={video.src} type="video/mp4" onError={() => { reporting.error(player.current?.error?.code); }} />
          </video>
        ) : null}
        {blocked && !failed ? <p role="status" className="mt-3 text-sm">Bấm nút Play để xem video.</p> : null}
        {failed ? <p role="alert" className="mt-3 text-sm">Chưa phát được video. Nàng có thể đóng để xem ảnh và tiếp tục mua hàng.</p> : null}
      </dialog>
    </div>
  );
}
