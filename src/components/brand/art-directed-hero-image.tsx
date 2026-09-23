import Image, { getImageProps } from "next/image";

export type ArtDirectedHeroImageProps = Readonly<{
  desktopSrc: string;
  mobileSrc?: string | null;
  alt: string;
  preload?: boolean;
  draggable?: boolean;
}>;

/**
 * One optimized hero image request per viewport.
 *
 * A pair of CSS-hidden <Image> elements still gives the browser two image candidates and, when
 * preloaded, requests both. Next's documented art-direction pattern uses <picture> plus
 * getImageProps() so the browser selects one source before fetching it.
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

  const {
    props: { srcSet: desktopSrcSet },
  } = getImageProps({
    src: desktopSrc,
    alt,
    fill: true,
    sizes: "100vw",
  });

  return (
    <picture>
      <source media="(min-width: 768px)" srcSet={desktopSrcSet} />
      <Image
        src={mobileSrc}
        alt={alt}
        fill
        sizes="100vw"
        fetchPriority={preload ? "high" : undefined}
        draggable={draggable}
        className="object-cover"
      />
    </picture>
  );
}
