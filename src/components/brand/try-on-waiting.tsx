"use client";

import { useEffect, useState } from "react";

import { TRY_ON_WAIT_STAGES, tryOnWaitStageIndex } from "@/components/headless/try-on-model";

/**
 * The picture shown while a try-on is being generated, in place of an empty grey box.
 *
 * It shows the shopper's own photo (a local blob, already on screen in the previous steps) under a
 * moving sheen and a scan line, with a caption that changes as the seconds pass. Everything here is
 * decoration: the dialog's own `role="status"` line is what is announced, once, so a screen reader is
 * not read a new sentence every few seconds, and the photo has an empty alt for the same reason. Under
 * `prefers-reduced-motion` the sheen, scan line and dots stand still and the caption stops fading;
 * the caption still changes because it is text, not motion. Styles are `.tryon-wait*` in globals.css.
 */
export function BrandTryOnWaiting({ previewUrl }: Readonly<{ previewUrl: string | null }>) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setStage(tryOnWaitStageIndex((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div aria-busy="true" className="tryon-wait mt-2" data-testid="try-on-waiting">
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob preview; next/image cannot optimise it.
        <img src={previewUrl} alt="" aria-hidden="true" className="tryon-wait__photo" />
      ) : null}
      <span aria-hidden="true" className="tryon-wait__sweep" />
      <span aria-hidden="true" className="tryon-wait__scan" />
      <div aria-hidden="true" className="tryon-wait__caption">
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
