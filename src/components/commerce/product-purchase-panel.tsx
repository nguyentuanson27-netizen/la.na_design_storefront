"use client";

import type { StorefrontProjectionOption } from "@/commerce/storefront-projection";
import type { DeepLinkedVariantSelection } from "@/commerce/storefront-variant-deep-link";
import { BrandPurchasePanel } from "@/components/brand/purchase-panel";

/**
 * The panel's public surface, kept so today's product page renders unchanged.
 *
 * Selection, money and the add-to-cart mutation now live in
 * `@/components/headless/use-variant-selection` (with its decisions in the pure
 * `variant-selection-model`), and markup in `@/components/brand/purchase-panel`. This is the seam
 * between them and holds no logic of its own. Once the storefront routes are migrated they will
 * render the brand panel directly and this file goes away; migrating them is later route work.
 */

type ProductPurchasePanelProps = {
  slug: string;
  productName: string;
  options: StorefrontProjectionOption[];
  /** Product-level options only: composite components must not speak for the parent before selection. */
  productLevelOptions: StorefrontProjectionOption[];
  initialSelection?: DeepLinkedVariantSelection | null;
  /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
  commerceTrackingEnabled?: boolean;
};

export function ProductPurchasePanel(props: ProductPurchasePanelProps) {
  return <BrandPurchasePanel {...props} />;
}
