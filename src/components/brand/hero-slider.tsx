"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { HOME_HERO_CTA_LABEL, type HomeHeroSlide } from "@/routes/home-hero";

/**
 * Markup and interaction only. Which slides exist is decided by `buildHomeHeroSlides`.
 *
 * Master spec §17 in three states: nothing at zero slides, a stable static hero at one, and an
 * autoplaying slider at two or three. The single-slide case is a different element tree rather than
 * a slider with its controls hidden -- a one-slide carousel is the broken empty state the acceptance
 * criterion names, and dots that cannot go anywhere are worse than no dots.
 *
 * Autoplay stops for three separate reasons and they are not the same reason:
 *   - `prefers-reduced-motion: reduce` means it never starts, and is watched rather than read once
 *     so a shopper who changes the setting is honoured without a reload;
 *   - hover and focus pause it and release it again, because the shopper is only looking;
 *   - an explicit move -- a dot, a swipe -- stops it for good, because they have taken over.
 *
 * Only the active slide is in the DOM flow; the others are `hidden`, which keeps their CTA out of
 * the tab order. That is what stops the keyboard walking through three identical links.
 */

const AUTOPLAY_INTERVAL_MS = 6_000;
/** Below this a drag is a tap or a vertical scroll, not a deliberate swipe. */
const SWIPE_THRESHOLD_PX = 40;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onStoreChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

/**
 * Read as an external store rather than mirrored into state in an effect.
 *
 * The effect version renders once with motion allowed and then corrects itself, which is a frame of
 * movement shown to the shopper who asked for none -- exactly the shopper the setting protects. The
 * server snapshot is `false` because the preference is not knowable there; hydration then reads the
 * real value before paint.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

function HeroSlideFigure({
  slide,
  preload,
}: Readonly<{ slide: HomeHeroSlide; preload: boolean }>) {
  return (
    <>
      <div className="home-hero__media">
        <Image
          src={slide.imageUrl}
          alt={slide.label}
          fill
          preload={preload}
          sizes="100vw"
          // Native image dragging would compete with the swipe gesture for the same pointer.
          draggable={false}
          className="object-cover"
        />
      </div>
      {/* Desktop overlays this over the image, mobile drops it below -- both from CSS, so the
          reading order the CTA has here is the one a screen reader gets on either. */}
      <p className="home-hero__cta">
        <Link className="btn btn--primary" href={slide.href}>
          {HOME_HERO_CTA_LABEL}
        </Link>
      </p>
    </>
  );
}

export function BrandHeroSlider({ slides }: Readonly<{ slides: readonly HomeHeroSlide[] }>) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tookOver, setTookOver] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const dragStartX = useRef<number | null>(null);

  const isSlider = slides.length > 1;
  const autoplaying = isSlider && !prefersReducedMotion && !paused && !tookOver;

  useEffect(() => {
    if (!autoplaying) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % slides.length);
    }, AUTOPLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoplaying, slides.length]);

  const goTo = useCallback(
    (index: number) => {
      setTookOver(true);
      setActiveIndex(((index % slides.length) + slides.length) % slides.length);
    },
    [slides.length],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartX.current = event.clientX;
    // Capture the pointer so the matching `up` comes back here. Without it a drag that starts on
    // the image or crosses the CTA becomes the browser's own image/link drag, which cancels the
    // gesture -- the swipe would then work everywhere except over the two things filling the hero.
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const startX = dragStartX.current;
      dragStartX.current = null;
      if (startX === null) return;
      const delta = event.clientX - startX;
      if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
      goTo(activeIndex + (delta < 0 ? 1 : -1));
    },
    [activeIndex, goTo],
  );

  // Zero slides omits the region outright: no empty frame, no placeholder, nothing announced.
  if (slides.length === 0) return null;

  if (!isSlider) {
    return (
      <section className="home-hero home-hero--static" aria-label="Ảnh bìa trang chủ">
        <HeroSlideFigure slide={slides[0]!} preload />
      </section>
    );
  }

  return (
    <section
      className="home-hero home-hero--slider"
      aria-label="Ảnh bìa trang chủ"
      aria-roledescription="carousel"
      data-autoplaying={autoplaying ? "true" : "false"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div
        className="home-hero__track"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragStartX.current = null;
        }}
      >
        {slides.map((slide, index) => (
          <div
            key={slide.href}
            className="home-hero__slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${index + 1} / ${slides.length}`}
            hidden={index !== activeIndex}
          >
            <HeroSlideFigure slide={slide} preload={index === 0} />
          </div>
        ))}
      </div>

      {/* Dots only. §17 rules out arrow controls. */}
      <div className="home-hero__dots" role="group" aria-label="Chọn ảnh bìa">
        {slides.map((slide, index) => (
          <button
            key={slide.href}
            type="button"
            className="home-hero__dot"
            aria-label={`Ảnh bìa ${index + 1}`}
            aria-current={index === activeIndex}
            onClick={() => goTo(index)}
          />
        ))}
      </div>
    </section>
  );
}
