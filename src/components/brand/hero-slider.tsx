"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { HOME_HERO_CTA_LABEL, type HomeHeroSlide } from "@/routes/home-hero";

/**
 * Owner-approved §17 hero: image + one linked CTA only.
 *
 * Zero slides render nothing. One slide is a static hero. Two or three slides autoplay every two
 * seconds unless reduced motion is requested or the shopper is actively hovering, focusing or
 * dragging. Manual swipe changes the slide but does not permanently take ownership of autoplay.
 */
const AUTOPLAY_INTERVAL_MS = 2_000;
/** Below this a drag is a tap or a vertical scroll, not a deliberate swipe. */
const SWIPE_THRESHOLD_PX = 40;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onStoreChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

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
          draggable={false}
          className="object-cover"
        />
      </div>
      <p className="home-hero__cta">
        <Link className="home-hero__cta-link" href={slide.href}>
          {HOME_HERO_CTA_LABEL}
        </Link>
      </p>
    </>
  );
}

export function BrandHeroSlider({ slides }: Readonly<{ slides: readonly HomeHeroSlide[] }>) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const dragStartX = useRef<number | null>(null);

  const isSlider = slides.length > 1;
  const autoplaying =
    isSlider && !prefersReducedMotion && !hovered && !focused && !interacting;

  useEffect(() => {
    if (!autoplaying) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % slides.length);
    }, AUTOPLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoplaying, slides.length]);

  const goTo = useCallback(
    (index: number) => {
      setActiveIndex(((index % slides.length) + slides.length) % slides.length);
    },
    [slides.length],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartX.current = event.clientX;
    setInteracting(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const finishPointerInteraction = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const startX = dragStartX.current;
      dragStartX.current = null;
      setInteracting(false);
      if (cancelled || startX === null) return;
      const delta = event.clientX - startX;
      if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
      goTo(activeIndex + (delta < 0 ? 1 : -1));
    },
    [activeIndex, goTo],
  );

  // Zero valid slides means there is no first-surface hero and therefore no header overlay marker.
  if (slides.length === 0) return null;

  if (!isSlider) {
    return (
      <section
        className="home-hero home-hero--static"
        aria-label="Ảnh bìa trang chủ"
        data-header-overlay-hero=""
      >
        <HeroSlideFigure slide={slides[0]!} preload />
      </section>
    );
  }

  return (
    <section
      className="home-hero home-hero--slider"
      aria-label="Ảnh bìa trang chủ"
      aria-roledescription="carousel"
      data-header-overlay-hero=""
      data-autoplaying={autoplaying ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      <div
        className="home-hero__track"
        onPointerDown={onPointerDown}
        onPointerUp={(event) => finishPointerInteraction(event)}
        onPointerCancel={(event) => finishPointerInteraction(event, true)}
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
    </section>
  );
}
