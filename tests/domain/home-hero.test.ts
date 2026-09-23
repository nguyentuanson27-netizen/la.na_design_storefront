import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHomeHeroSlides,
  HOME_HERO_CTA_LABEL,
  HOME_HERO_MAX_SLIDES,
  type HomeHeroSlideCandidate,
} from "../../src/routes/home-hero.ts";

/**
 * The hero's slide rule (master spec §17).
 *
 * These cover the drops, because a dropped slide is the failure that would otherwise show up as a
 * broken frame on the largest image on the site rather than as a test.
 */

const TRUSTED_IMAGE = "https://content.pancake.vn/1/2/3/4/hero.jpg";
const SECOND_TRUSTED_IMAGE = "https://content.pancake.vn/1/2/3/4/hero-two.jpg";
const THIRD_TRUSTED_IMAGE = "https://content.pancake.vn/1/2/3/4/hero-three.jpg";
const FOURTH_TRUSTED_IMAGE = "https://content.pancake.vn/1/2/3/4/hero-four.jpg";

function candidate(overrides: Partial<HomeHeroSlideCandidate> = {}): HomeHeroSlideCandidate {
  return {
    imageUrl: TRUSTED_IMAGE,
    href: "/collections/ao-dai-tet",
    label: "Áo dài Tết",
    ...overrides,
  };
}

test("no candidates means no hero at all, rather than an empty carousel", () => {
  assert.deepEqual(buildHomeHeroSlides([]), []);
});

test("a single valid candidate yields exactly one slide", () => {
  const slides = buildHomeHeroSlides([candidate()]);

  assert.equal(slides.length, 1);
  assert.deepEqual(slides[0], {
    imageUrl: TRUSTED_IMAGE,
    mobileImageUrl: null,
    href: "/collections/ao-dai-tet",
    label: "Áo dài Tết",
  });
});

test("two and three candidates are kept in the order they arrive", () => {
  const slides = buildHomeHeroSlides([
    candidate({ imageUrl: TRUSTED_IMAGE, href: "/collections/one", label: "One" }),
    candidate({ imageUrl: SECOND_TRUSTED_IMAGE, href: "/collections/two", label: "Two" }),
    candidate({ imageUrl: THIRD_TRUSTED_IMAGE, href: "/collections/three", label: "Three" }),
  ]);

  assert.deepEqual(
    slides.map((slide) => slide.href),
    ["/collections/one", "/collections/two", "/collections/three"],
  );
});

test("a fourth candidate is dropped rather than rendered", () => {
  const slides = buildHomeHeroSlides([
    candidate({ imageUrl: TRUSTED_IMAGE, href: "/collections/one", label: "One" }),
    candidate({ imageUrl: SECOND_TRUSTED_IMAGE, href: "/collections/two", label: "Two" }),
    candidate({ imageUrl: THIRD_TRUSTED_IMAGE, href: "/collections/three", label: "Three" }),
    candidate({ imageUrl: FOURTH_TRUSTED_IMAGE, href: "/collections/four", label: "Four" }),
  ]);

  assert.equal(slides.length, HOME_HERO_MAX_SLIDES);
  assert.ok(!slides.some((slide) => slide.href === "/collections/four"));
});

test("a candidate with no image contributes nothing, so absence stays absence", () => {
  assert.deepEqual(buildHomeHeroSlides([candidate({ imageUrl: null })]), []);
});

test("an untrusted image origin drops the slide instead of reaching the page", () => {
  assert.deepEqual(
    buildHomeHeroSlides([candidate({ imageUrl: "https://evil.example.com/hero.jpg" })]),
    [],
  );
});

test("an off-site destination drops the slide", () => {
  assert.deepEqual(buildHomeHeroSlides([candidate({ href: "https://example.com/sale" })]), []);
});

test("a protocol-relative destination drops the slide", () => {
  assert.deepEqual(buildHomeHeroSlides([candidate({ href: "//example.com/sale" })]), []);
});

test("a blank label drops the slide, because the image would have no accessible name", () => {
  assert.deepEqual(buildHomeHeroSlides([candidate({ label: "   " })]), []);
});

test("one invalid candidate does not take the valid ones with it", () => {
  const slides = buildHomeHeroSlides([
    candidate({ imageUrl: null, href: "/collections/broken", label: "Broken" }),
    candidate({ imageUrl: SECOND_TRUSTED_IMAGE, href: "/collections/kept", label: "Kept" }),
  ]);

  assert.deepEqual(
    slides.map((slide) => slide.href),
    ["/collections/kept"],
  );
});

test("the approved CTA wording is published as one constant, not per slide", () => {
  assert.equal(HOME_HERO_CTA_LABEL, "MUA NGAY");
});

test("a candidate with a trusted mobile image passes it through to the slide", () => {
  const slides = buildHomeHeroSlides([
    candidate({
      imageUrl: TRUSTED_IMAGE,
      mobileImageUrl: SECOND_TRUSTED_IMAGE,
      href: "/collections/one",
      label: "One",
    }),
  ]);

  assert.equal(slides.length, 1);
  assert.equal(slides[0]?.mobileImageUrl, SECOND_TRUSTED_IMAGE);
});

test("an untrusted mobile image origin falls back to null rather than dropping the slide", () => {
  const slides = buildHomeHeroSlides([
    candidate({
      imageUrl: TRUSTED_IMAGE,
      mobileImageUrl: "https://evil.example.com/mobile-hero.jpg",
      href: "/collections/one",
      label: "One",
    }),
  ]);

  assert.equal(slides.length, 1);
  assert.equal(slides[0]?.imageUrl, TRUSTED_IMAGE);
  assert.equal(slides[0]?.mobileImageUrl, null);
});

