import type { StorefrontProductProjection } from "./storefront-projection.ts";
import {
  buildStorefrontVariantOptions,
  type StorefrontVariantFacts,
} from "./storefront-product.ts";

const MAX_STOREFRONT_SLUG_LENGTH = 160;
const MAX_STOREFRONT_VARIANT_ID_LENGTH = 200;
const MAX_PDP_QUANTITY = 99;

type StorefrontPurchaseCatalog = {
  getProductBySlug(input: {
    shopId: number;
    slug: string;
    now?: Date;
  }): Promise<
    | {
        variants: StorefrontVariantFacts[];
        projection?: StorefrontProductProjection;
      }
    | null
  >;
};

type AddUnitInput = {
  variantId: string;
};

type AddQuantityInput = {
  variantId: string;
  quantity: number;
};

type StorefrontPurchaseFailure =
  | { ok: false; reason: "INVALID_SELECTION" }
  | { ok: false; reason: "VARIANT_UNAVAILABLE" };

function isBoundedTrimmed(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && value === value.trim();
}

/**
 * The PDP purchase path.
 *
 * Quantity is an increment delta, never an absolute cart-line value. The mutation authorizes the
 * prospective total under the cart lock, so adding three units to a line that already holds two is
 * a single atomic 2 → 5 transition rather than three partially-successful requests.
 *
 * The option lookup below authorizes the request against the current public projection, but it is
 * not the authority: it runs before the cart row is locked. The mutation re-resolves the same facts
 * inside its transaction, so this exists to reject obviously invalid input cheaply and to map the
 * browser's option id onto the authorized internal id.
 */
export function createStorefrontPurchaseService<TResult>({
  catalog,
  addQuantity,
  addUnit,
}: {
  catalog: StorefrontPurchaseCatalog;
  addQuantity?: (input: AddQuantityInput) => Promise<TResult>;
  /** Compatibility for existing one-unit callers/tests; quantity > 1 requires addQuantity. */
  addUnit?: (input: AddUnitInput) => Promise<TResult>;
}) {
  async function add({
    shopId,
    slug,
    variantId,
    quantity = 1,
    now,
  }: {
    shopId: number;
    slug: string;
    variantId: string;
    quantity?: number;
    /** Fixed by the caller so this pre-check and the mutation resolve one campaign instant. */
    now?: Date;
  }): Promise<TResult | StorefrontPurchaseFailure> {
    if (
      typeof slug !== "string" ||
      typeof variantId !== "string" ||
      !isBoundedTrimmed(slug, MAX_STOREFRONT_SLUG_LENGTH) ||
      !isBoundedTrimmed(variantId, MAX_STOREFRONT_VARIANT_ID_LENGTH) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_PDP_QUANTITY
    ) {
      return { ok: false, reason: "INVALID_SELECTION" };
    }

    const product = await catalog.getProductBySlug({ shopId, slug, now });
    if (!product) {
      return { ok: false, reason: "VARIANT_UNAVAILABLE" };
    }

    const selected = product.projection
      ? product.projection.options.find((option) => option.id === variantId)
      : buildStorefrontVariantOptions(product.variants).find(
          (variant) => variant.id === variantId,
        );
    if (!selected?.purchasable) {
      return { ok: false, reason: "VARIANT_UNAVAILABLE" };
    }

    if (addQuantity) {
      return addQuantity({ variantId: selected.id, quantity });
    }
    if (quantity === 1 && addUnit) {
      return addUnit({ variantId: selected.id });
    }
    return { ok: false, reason: "INVALID_SELECTION" };
  }

  return { add };
}
