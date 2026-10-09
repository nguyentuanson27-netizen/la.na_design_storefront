import { getImageProps, type ImageLoader } from "next/image";
import { preload } from "react-dom";

/**
 * A high-priority preload hint for one responsive image, followed only by browsers whose viewport
 * matches `media`.
 *
 * `next/image`'s own `preload` emits the hint unscoped, so a page that draws a different photograph
 * (or the same one at a different `sizes`) per viewport would have every browser fetch every
 * variant. Called during render, like Next's own preload: React hoists the hint into `<head>`.
 */
export function preloadImageForViewport({
  src,
  sizes,
  media,
  loader,
}: Readonly<{ src: string; sizes: string; media: string; loader?: ImageLoader }>): void {
  const { props } = getImageProps({ src, alt: "", fill: true, sizes, loader });
  preload(props.src, {
    as: "image",
    imageSrcSet: props.srcSet,
    imageSizes: props.sizes,
    fetchPriority: "high",
    media,
  });
}
