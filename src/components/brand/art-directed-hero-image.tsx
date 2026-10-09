import Image, { getImageProps } from "next/image";

import { preloadImageForViewport } from "@/components/brand/viewport-image-preload";

export type ArtDirectedHeroImageProps = Readonly<{
  desktopSrc: string;
  mobileSrc?: string | null;
  alt: string;
  preload?: boolean;
  draggable?: boolean;
}>;

/** The viewport split the `<source>` below draws. The two queries are exact complements. */
const DESKTOP_MEDIA = "(min-width: 768px)";
const MOBILE_MEDIA = "(max-width: 767.98px)";

/**
 * One optimized hero image request per viewport.
 *
 * A pair of CSS-hidden <Image> elements still gives the browser two image candidates and, when
 * preloaded, requests both. Next's documented art-direction pattern uses <picture> plus
 * getImageProps() so the browser selects one source before fetching it.
 *
 * `preload` cannot go on the <Image> here: Next would emit one unscoped preload for the mobile
 * source and every desktop would fetch it as well. So the art-directed pair is preloaded by hand,
 * one hint per viewport, each scoped by `media` so a browser follows only the one it will paint.
 * The <img> itself must then be eager -- left to Next's default it is `loading="lazy"`, which holds
 * a phone's LCP image back until layout.
 */
export function ArtDirectedHeroImage({
  desktopSrc,
  mobileSrc = null,
  alt,
  preload = false,
  draggable,
}: ArtDirectedHeroImageProps) {
  if (!mobileSrc) {
    return (
      <Image
        src={desktopSrc}
        alt={alt}
        fill
        preload={preload}
        sizes="100vw"
        draggable={draggable}
        className="object-cover"
      />
    );
  }

  const { props: desktopProps } = getImageProps({ src: desktopSrc, alt, fill: true, sizes: "100vw" });

  if (preload) {
    preloadImageForViewport({ src: mobileSrc, sizes: "100vw", media: MOBILE_MEDIA });
    preloadImageForViewport({ src: desktopSrc, sizes: "100vw", media: DESKTOP_MEDIA });
  }

  return (
    <picture>
      <source media={DESKTOP_MEDIA} srcSet={desktopProps.srcSet} sizes={desktopProps.sizes} />
      <Image
        src={mobileSrc}
        alt={alt}
        fill
        sizes="100vw"
        loading={preload ? "eager" : undefined}
        fetchPriority={preload ? "high" : undefined}
        draggable={draggable}
        className="object-cover"
      />
    </picture>
  );
}
