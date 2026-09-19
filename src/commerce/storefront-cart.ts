import {
  resolveStorefrontProductMedia,
  type StorefrontProductMedia,
} from "./product-media.ts";
import {
  evaluateVariantCapacity,
  resolveAcceptedPreorderState,
  type SellingMode,
  type VariantCapacityInput,
} from "./capacity-policy.ts";
import {
  buildStorefrontVariantOptions,
  defaultStorefrontPricingRule,
  STANDARD_STANDALONE_CAPACITY,
  type StorefrontPricingRule,
  type StorefrontProductCapacity,
  type StorefrontVariantUnavailableReason,
} from "./storefront-product.ts";

export type StorefrontCartItem = {
  variantId: string;
  quantity: number;
};

export type StorefrontCartVariant = {
  /** Internal mutation/authorization identity. Never a vendor-facing external id. */
  id: string;
  /** The external variation identity a buyer actually committed to. */
  pancakeVariationId: string;
  isPresent: boolean;
  isActive: boolean;
  isCompositeComponentAvailable?: boolean;
  color: string | null;
  size: string | null;
  sellableStock: number;
  retailPrice: number | null;
  retailPriceAfterDiscount: number | null;
  imageUrls?: readonly string[];
};

export type StorefrontCartProduct = {
  slug: string;
  pancakeProductId: string;
  name: string;
  isPresent: boolean;
  isActive: boolean;
  primaryImageUrl?: string | null;
  /**
   * I5 — the product's stored selling policy, as `resolveSellingPolicy()` returns it.
   *
   * Optional, defaulting to the approved missing-row answer (`STANDARD` at `−20`), so a caller that
   * has not been switched keeps exactly today's behaviour. That default is what made I1's
   * no-backfill safe and it does the same job here.
   */
  sellingPolicy?: Readonly<{ sellingMode: SellingMode; negativeStockLimit: number }>;
  /**
   * Whether this product is a composite parent (ADR 0014 §11 disables `OVERSELL`/`PREORDER` for
   * one). Product-level rather than per variant, matching how I2's admin boundary refuses the write
   * and how I6a's reservation transaction tests it — three places agreeing on one granularity.
   */
  isComposite?: boolean;
  variants: readonly StorefrontCartVariant[];
};

export type StorefrontCartUnavailableReason =
  | StorefrontVariantUnavailableReason
  | "INSUFFICIENT_STOCK"
  | "PRODUCT_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE";

export type StorefrontCartLine = {
  /**
   * Internal mutation identity, echoed back for the requested item even when nothing resolved.
   * `VariantMirror.id` stays the authorization key and is never substituted for external identity.
   */
  variantId: string;
  /**
   * The purchased variation's external identity, or null when the line resolved to no real variant.
   *
   * Null means "not known", never "not applicable": a line that resolved to a real variant keeps its
   * identity even when unavailable, because the buyer committed to that variation and order audit
   * and Purchase both need it. A composite component keeps it too, despite a non-public owner.
   */
  pancakeVariationId: string | null;
  /**
   * Public product identity, withheld exactly where the public slug is: a private owner exposes no
   * product-level identity, which is what keeps a composite component's parent out of vendor feeds.
   */
  pancakeProductId: string | null;
  productSlug: string | null;
  productName: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  price: number | null;
  available: boolean;
  /**
   * F8b / master spec §30 — whether this line is a `Đặt trước` sale, as the capacity authority
   * classified it when the line was resolved.
   *
   * Carried on the line rather than re-derived downstream, because cart and checkout must say the
   * same thing about the same line and neither is allowed to compare stock against a limit. It is
   * false whenever the line is unavailable: a line the shopper cannot buy is not a preorder sale,
   * and labelling one `Đặt trước` would promise a preparation window for something that will not
   * be ordered at all.
   */
  isPreorderSale: boolean;
  unavailableReason: StorefrontCartUnavailableReason | null;
  media: StorefrontProductMedia;
};

function normalizedOptionValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isPublicOwner(product: StorefrontCartProduct): boolean {
  return product.isPresent && product.isActive;
}

function isCommerceEligibleVariant(
  product: StorefrontCartProduct,
  variant: StorefrontCartVariant,
): boolean {
  return (
    variant.isPresent &&
    variant.isActive &&
    (isPublicOwner(product) || variant.isCompositeComponentAvailable === true)
  );
}

const emptyMedia: StorefrontProductMedia = { primary: null, gallery: [] };

/**
 * Resolves the current cart lines for a set of requested items.
 *
 * `pricingRule` is the same injectable seam the product page and listings use, so a caller that
 * supplies the promotion-aware rule gets exactly the money the central resolver decides — the cart,
 * the checkout render, the order snapshot and the analytics projection all read one price for one
 * variant at one instant. Callers that have not switched keep the default equality-gated rule.
 */
export function buildStorefrontCartLines({
  items,
  products,
  pricingRule = defaultStorefrontPricingRule,
}: {
  items: readonly StorefrontCartItem[];
  products: readonly StorefrontCartProduct[];
  pricingRule?: StorefrontPricingRule;
}): StorefrontCartLine[] {
  const variantOwner = new Map<string, StorefrontCartProduct>();
  const productMediaMap = new Map<string, StorefrontProductMedia>();
  const resolvedOptions = new Map<string, ReturnType<typeof buildStorefrontVariantOptions>[number]>();
  const capacityByVariantId = new Map<string, StorefrontProductCapacity>();

  for (const product of products) {
    const media = resolveStorefrontProductMedia({
      productName: product.name,
      primaryImageUrl: product.primaryImageUrl,
      variantImageUrls: product.variants.map((variant) => variant.imageUrls ?? []),
    });
    productMediaMap.set(product.slug, media);

    for (const variant of product.variants) {
      variantOwner.set(variant.id, product);
    }

    // I5 — the product's real capacity facts, not the hard-coded default. Without this the cart
    // judged every product by `STANDARD`'s floor of 0, so an `OVERSELL` variant the owner had
    // allowed down to −20 was refused here while the PDP (since I4) offered it: the display and the
    // cart disagreeing about one product, which is the drift this series exists to remove.
    const productCapacity: StorefrontProductCapacity = {
      sellingMode: product.sellingPolicy?.sellingMode ?? STANDARD_STANDALONE_CAPACITY.sellingMode,
      negativeStockLimit:
        product.sellingPolicy?.negativeStockLimit ?? STANDARD_STANDALONE_CAPACITY.negativeStockLimit,
      isComposite: product.isComposite ?? false,
    };

    const currentVariants = product.variants.filter((variant) =>
      isCommerceEligibleVariant(product, variant),
    );
    for (const option of buildStorefrontVariantOptions(currentVariants, pricingRule, productCapacity)) {
      resolvedOptions.set(option.id, option);
      capacityByVariantId.set(option.id, productCapacity);
    }
  }

  return items.map((item) => {
    const product = variantOwner.get(item.variantId);
    const media = (product ? productMediaMap.get(product.slug) : null) ?? emptyMedia;

    if (!product) {
      return {
        variantId: item.variantId,
        pancakeVariationId: null,
        pancakeProductId: null,
        productSlug: null,
        productName: null,
        color: null,
        size: null,
        quantity: item.quantity,
        price: null,
        available: false,
        isPreorderSale: false,
        unavailableReason: "VARIANT_UNAVAILABLE",
        media,
      };
    }

    const variant = product.variants.find(({ id }) => id === item.variantId);
    if (!variant) {
      return {
        variantId: item.variantId,
        // The owner is known but this variant is not, so there is no variation identity to report
        // and inventing one would put a fictional item into an analytics or order payload.
        pancakeVariationId: null,
        pancakeProductId: null,
        productSlug: isPublicOwner(product) ? product.slug : null,
        productName: product.name,
        color: null,
        size: null,
        quantity: item.quantity,
        price: null,
        available: false,
        isPreorderSale: false,
        unavailableReason: "VARIANT_UNAVAILABLE",
        media,
      };
    }

    const base = {
      variantId: item.variantId,
      pancakeVariationId: variant.pancakeVariationId,
      pancakeProductId: isPublicOwner(product) ? product.pancakeProductId : null,
      productSlug: isPublicOwner(product) ? product.slug : null,
      productName: product.name,
      color: normalizedOptionValue(variant.color),
      size: normalizedOptionValue(variant.size),
      quantity: item.quantity,
      media,
    };

    if (!isPublicOwner(product) && variant.isCompositeComponentAvailable !== true) {
      return {
        ...base,
        price: null,
        available: false,
        isPreorderSale: false,
        unavailableReason: "PRODUCT_UNAVAILABLE" as const,
      };
    }

    if (!variant.isPresent || !variant.isActive) {
      return {
        ...base,
        price: null,
        available: false,
        isPreorderSale: false,
        unavailableReason: "VARIANT_UNAVAILABLE" as const,
      };
    }

    const option = resolvedOptions.get(item.variantId);
    if (!option) {
      return {
        ...base,
        price: null,
        available: false,
        isPreorderSale: false,
        unavailableReason: "VARIANT_UNAVAILABLE" as const,
      };
    }

    // I5 — "may this many be sold" is `evaluateVariantCapacity()` at the requested quantity: the
    // same predicate `buildStorefrontVariantOptions()` used above at quantity 1, and the same one
    // I6a's reservation transaction will use at commit. It replaces `sellableStock < quantity`,
    // which was a second capacity rule pinned to `STANDARD`'s floor of 0 — it refused 5 units of an
    // `OVERSELL` variant sitting at stock 2 even though the owner's −20 allowance covers it, and it
    // agreed with the real rule only because nothing could set a non-`STANDARD` policy yet.
    //
    // Advisory, per ADR 0014 §2: no reservation is subtracted here, because the authoritative check
    // runs at the commit boundary inside the reservation transaction. The cart may show a line as
    // buyable and the commit may still refuse it, and that refusal is correct.
    if (option.purchasable) {
      const capacity = capacityByVariantId.get(item.variantId);
      const decision = evaluateVariantCapacity(
        {
          mirroredStock: variant.sellableStock,
          activeReservedQuantity: 0,
          sellingMode: capacity?.sellingMode ?? STANDARD_STANDALONE_CAPACITY.sellingMode,
          negativeStockLimit:
            capacity?.negativeStockLimit ?? STANDARD_STANDALONE_CAPACITY.negativeStockLimit,
          isComposite: capacity?.isComposite ?? false,
        } satisfies VariantCapacityInput,
        item.quantity,
      );
      if (!decision.allowed) {
        // `purchasable` already established that one unit sells, so the only thing that can have
        // failed here is the requested count — the shopper can still buy fewer, which is what
        // INSUFFICIENT_STOCK tells them. A variant that cannot sell at all falls through to
        // `option.unavailableReason` below instead, keeping "sold out" distinct from "not enough".
        return {
          ...base,
          price: option.price,
          available: false,
          isPreorderSale: false,
          unavailableReason: "INSUFFICIENT_STOCK" as const,
        };
      }
    }

    const capacity = capacityByVariantId.get(item.variantId);

    return {
      ...base,
      price: option.price,
      available: option.purchasable,
      // Quantity-aware, from the same authority the reservation writes history with. The option's
      // own `isPreorderSale` answers "is one more unit a preorder sale", which is the wrong
      // question for a line of two: a PREORDER variant with one unit of ready stock is a ready
      // sale at quantity 1 and a preorder sale at quantity 2. Reading the unit-level answer here
      // showed the buyer a ready checkout while `acceptedPreorderState` persisted PREORDER.
      isPreorderSale:
        option.purchasable &&
        capacity !== undefined &&
        resolveAcceptedPreorderState(
          {
            mirroredStock: variant.sellableStock,
            activeReservedQuantity: 0,
            sellingMode: capacity.sellingMode,
            negativeStockLimit: capacity.negativeStockLimit,
            isComposite: capacity.isComposite,
          },
          item.quantity,
        ) === "PREORDER",
      unavailableReason: option.unavailableReason,
    };
  });
}
