import { buildPdpImageDeliveryUrl } from "@/commerce/product-image-delivery";

export function pdpProductImageLoader({
  src,
  width,
}: Readonly<{ src: string; width: number; quality?: number }>): string {
  return buildPdpImageDeliveryUrl({ src, width });
}
