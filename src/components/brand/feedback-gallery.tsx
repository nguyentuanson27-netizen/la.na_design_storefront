import Image from "next/image";
import Link from "next/link";

import type { HomeFeedbackSection } from "@/routes/home-model";

type FeedbackImage = HomeFeedbackSection["images"][number];

/**
 * Customer feedback photographs (spec §7.6): the homepage rail and the `/feedback` gallery.
 *
 * Images only. No customer name, product name, quote or caption is rendered, and no photograph is a
 * link -- each carries only the alt decision its config entry made. Every image is lazy and sits in
 * a fixed 3:4 box, so a long gallery neither eager-loads nor shifts the page as it arrives.
 */

function FeedbackPhoto({ image, sizes }: Readonly<{ image: FeedbackImage; sizes: string }>) {
  return (
    <div className="feedback-photo">
      <Image src={image.src} alt={image.alt} fill sizes={sizes} className="object-cover" />
    </div>
  );
}

/**
 * The homepage rail: native horizontal scroll with snap points, no carousel dependency and no
 * autoplay. Touch swipes it; a mouse uses its scrollbar or a trackpad; the keyboard focuses the
 * viewport and scrolls it with the arrow keys. The title is a heading, not a link -- the way to the
 * full gallery is the `Xem thêm` link after the rail.
 */
export function FeedbackRail({
  title,
  ctaLabel,
  href,
  images,
}: Readonly<{ title: string; ctaLabel: string; href: string; images: readonly FeedbackImage[] }>) {
  return (
    <section
      className="feedback-rail"
      aria-labelledby="home-feedback-title"
      data-homepage-region="feedback"
    >
      <div className="section-heading-row">
        <h2 id="home-feedback-title">{title}</h2>
      </div>
      <div className="feedback-rail__viewport" tabIndex={0} role="group" aria-label={title}>
        <ul className="feedback-rail__track">
          {images.map((image, index) => (
            <li className="feedback-rail__item" key={`${index}-${image.src}`}>
              <FeedbackPhoto image={image} sizes="(min-width: 901px) 20vw, 42vw" />
            </li>
          ))}
        </ul>
      </div>
      <p className="home-more">
        <Link href={href}>
          {ctaLabel}
          <span className="sr-only">: {title}</span>
        </Link>
      </p>
    </section>
  );
}

/** The `/feedback` page's full gallery, in the configured order. */
export function FeedbackGallery({ images }: Readonly<{ images: readonly FeedbackImage[] }>) {
  return (
    <ul className="feedback-gallery">
      {images.map((image, index) => (
        <li key={`${index}-${image.src}`}>
          <FeedbackPhoto image={image} sizes="(min-width: 901px) 25vw, 50vw" />
        </li>
      ))}
    </ul>
  );
}
