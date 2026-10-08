import {
  buildPdpImageDeliveryUrl,
  stripPancakeProductImageSuffix,
} from "@/commerce/product-image-delivery";

export function pdpProductImageLoader({
  src,
  width,
}: Readonly<{ src: string; width: number; quality?: number }>): string {
  // The endpoint accepts only the bare reviewed URL; a stored query/fragment is not part of the
  // image identity and would otherwise be refused.
  return buildPdpImageDeliveryUrl({ src: stripPancakeProductImageSuffix(src), width });
}
