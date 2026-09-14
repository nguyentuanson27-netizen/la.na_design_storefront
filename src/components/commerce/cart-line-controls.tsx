"use client";

import { BrandCartLineControls } from "@/components/brand/cart-line-controls";

/**
 * The editor's public surface, kept so today's cart page renders unchanged.
 *
 * The quantity rules and mutations now live in `@/components/headless/use-cart-line` (with their
 * decisions in the pure `cart-line-model`) and the markup in
 * `@/components/brand/cart-line-controls`. This is the seam between them and holds no logic of its
 * own.
 */

type CartLineControlsProps = {
  variantId: string;
  initialQuantity: number;
  canUpdate: boolean;
  /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
  commerceTrackingEnabled?: boolean;
};

export function CartLineControls(props: CartLineControlsProps) {
  return <BrandCartLineControls {...props} />;
}
