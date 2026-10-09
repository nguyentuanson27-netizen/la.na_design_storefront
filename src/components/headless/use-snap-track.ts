"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** A mouse drag shorter than this springs back to the photograph it started on. */
const MOUSE_SWIPE_THRESHOLD_PX = 40;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

function animatedScrollBehavior(): ScrollBehavior {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches ? "instant" : "smooth";
}

type MouseDrag = {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  startIndex: number;
  moved: boolean;
};

/**
 * A horizontal, one-photograph-per-page gallery built on native scroll snapping.
 *
 * The browser does the swiping: a finger moves the track under it at the display's frame rate, a
 * fling carries momentum, `scroll-snap-stop: always` stops it on the next photograph, and the
 * browser -- not a threshold of our own -- decides whether a diagonal thumb meant the gallery or
 * the page. This hook only reads where the track came to rest and decides which photographs are
 * mounted.
 *
 * Mounting is what keeps a phone's page weight down: a photograph's `<img>` exists only once the
 * shopper has been on it or next to it (`mounted`), so the gallery never downloads photographs
 * nobody looked at. The caller widens that set itself with `mount` -- the product page, for one,
 * adds the second photograph once the document has loaded so the first swipe lands on a photograph
 * that is already there.
 *
 * A mouse cannot pan a scroll container, so a mouse (or pen) drag is translated into scrolling by
 * hand and settles on the nearest neighbour when released; touch never takes that path. A drag
 * also swallows the click that ends it, so dragging never opens what tapping would.
 */
export function useSnapTrack({ count }: Readonly<{ count: number }>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<MouseDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [index, setIndex] = useState(0);
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([0]));

  const mount = useCallback(
    (indices: readonly number[]) => {
      setMounted((current) => {
        const additions = indices.filter(
          (candidate) => candidate >= 0 && candidate < count && !current.has(candidate),
        );
        if (additions.length === 0) return current;
        const next = new Set(current);
        for (const addition of additions) next.add(addition);
        return next;
      });
    },
    [count],
  );

  const readPosition = useCallback(() => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return null;
    return track.scrollLeft / track.clientWidth;
  }, []);

  const onScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const position = readPosition();
      if (position === null) return;
      const nearest = clampIndex(Math.round(position), count);
      setIndex(nearest);
      // Whatever is partly on screen, plus one ahead in either direction.
      mount([Math.floor(position), Math.ceil(position), nearest - 1, nearest + 1]);
    });
  }, [count, mount, readPosition]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** Moves the track to `target`. Instant by default: a jump is not a gesture to animate. */
  const scrollToIndex = useCallback(
    (target: number, behavior: "instant" | "animated" = "instant") => {
      const clamped = clampIndex(target, count);
      mount([clamped - 1, clamped, clamped + 1]);
      setIndex(clamped);
      const track = trackRef.current;
      if (!track) return;
      track.scrollTo({
        left: clamped * track.clientWidth,
        behavior: behavior === "animated" ? animatedScrollBehavior() : "instant",
      });
    },
    [count, mount],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
      const track = event.currentTarget;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: track.scrollLeft,
        startIndex: clampIndex(Math.round(track.scrollLeft / Math.max(track.clientWidth, 1)), count),
        moved: false,
      };
    },
    [count],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const track = event.currentTarget;
    const deltaX = event.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(deltaX) < 4) return;
      drag.moved = true;
      // Snapping would pull every hand-set offset straight back; it returns when the drag ends.
      track.dataset.dragging = "";
      track.setPointerCapture(event.pointerId);
    }
    track.scrollLeft = drag.startScrollLeft - deltaX;
  }, []);

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!drag.moved) return;
      const track = event.currentTarget;
      delete track.dataset.dragging;
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
      suppressClickRef.current = true;
      const deltaX = event.clientX - drag.startX;
      const step =
        cancelled || Math.abs(deltaX) < MOUSE_SWIPE_THRESHOLD_PX ? 0 : deltaX < 0 ? 1 : -1;
      scrollToIndex(drag.startIndex + step, "animated");
    },
    [scrollToIndex],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishDrag(event, false),
    [finishDrag],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishDrag(event, true),
    [finishDrag],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // A drag that ends without a click (released off the track) must not swallow the next real one.
  const onPointerDownCapture = useCallback(() => {
    suppressClickRef.current = false;
  }, []);

  return {
    trackRef,
    index,
    mounted,
    mount,
    scrollToIndex,
    trackProps: {
      ref: trackRef,
      onScroll,
      onPointerDownCapture,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
  };
}
