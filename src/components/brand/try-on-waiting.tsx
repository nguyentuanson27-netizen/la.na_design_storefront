"use client";

import { useEffect, useState } from "react";

import {
  TRY_ON_WAIT_STAGES,
  tryOnWaitProgress,
  tryOnWaitStageIndex,
} from "@/components/headless/try-on-model";

/** Seconds since `startedAt`, ticking once a second. */
export function useTryOnElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
}

/**
 * The picture shown while a try-on is being generated, in place of an empty grey box.
 *
 * It shows the shopper's own photo (a local blob, already on screen in the previous steps) under a
 * moving sheen and a scan line, with a caption that changes as the seconds pass and a bar paced on
 * the usual wait (`tryOnWaitProgress`: 90 % at the usual minute, never full before the picture is).
 * Both are measured from when the job started, not from when this mounted, so a dialog reopened half
 * way through picks up where the wait really is.
 *
 * Everything here is decoration: the dialog's own `role="status"` line is what is announced, once, so
 * a screen reader is not read a new sentence every few seconds, and the photo has an empty alt for
 * the same reason. Under `prefers-reduced-motion` the sheen, scan line and dots stand still and the
 * caption stops fading; the caption and the bar still change because they report the wait, but the
 * bar jumps rather than glides. Styles are `.tryon-wait*` in globals.css.
 */
export function BrandTryOnWaiting({
  photoUrl,
  startedAt,
}: Readonly<{ photoUrl: string | null; startedAt: number | null }>) {
  const elapsed = useTryOnElapsedSeconds(startedAt);
  const stage = tryOnWaitStageIndex(elapsed);

  return (
    <div aria-busy="true" className="tryon-wait mt-2" data-testid="try-on-waiting">
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob preview; next/image cannot optimise it.
        <img src={photoUrl} alt="" aria-hidden="true" className="tryon-wait__photo" />
      ) : null}
      <span aria-hidden="true" className="tryon-wait__sweep" />
      <span aria-hidden="true" className="tryon-wait__scan" />
      <div aria-hidden="true" className="tryon-wait__caption">
        <span className="tryon-wait__bar">
          <span style={{ transform: `scaleX(${tryOnWaitProgress(elapsed)})` }} />
        </span>
        <span key={stage} className="tryon-wait__label">
          {TRY_ON_WAIT_STAGES[stage]!.label}
        </span>
        <span className="tryon-wait__dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}
