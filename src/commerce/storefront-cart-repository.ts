import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import type { GiftQuantityCandidateReadClient } from "./gift-quantity-candidate-repository.ts";
import { resolveGiftQuantityQuote, validateQuoteCartItems, type LegacyConsentReader, type QuoteCartLine, type QuantityAddition, type QuantityGiftGuard } from "./gift-quantity-quote.ts";
import { createLegacyConsentReader } from "./gift-quantity-legacy-consent.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import type { PromotionPricingResult } from "./promotion-pricing.ts";
import type { PromotionCandidateReadClient } from "./promotion-candidate-repository.ts";
import { buildStorefrontCartLines } from "./storefront-cart.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import { buildCartLineUrgency, type CartLineUrgency } from "./storefront-cart-urgency.ts";
import {
  deriveCompositeCapacitySnapshot,
  deriveCompositeSellableStock,
} from "./composite-capacity.ts";
import { resolveSellingPolicy } from "./capacity-policy.ts";
import { readAdvisoryHeldQuantities, type AdvisoryHoldReadClient } from "./capacity-advisory.ts";
import {
  compositeSubSetAuthorityComponentSelection,
  cartVariantCommerceSelection,
  resolveCartVariantCommerceFlags,
} from "./composite-subset-authority.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

type CartItemIdentity = {
  variantId: string;
  quantity: number;
  sourceProductSlug?: string | null;
};

function parseShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new RangeError("Storefront cart shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

function parseItems(items: readonly CartItemIdentity[]): readonly CartItemIdentity[] {
  if (items.length > ANONYMOUS_CART_MAX_DISTINCT_ITEMS) {
    throw new RangeError(
      `Storefront cart cannot resolve more than ${ANONYMOUS_CART_MAX_DISTINCT_ITEMS} lines`,
    );
  }
  return items;
}

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) {
      throw new Error("Storefront cart contains malformed warehouse quantity");
    }
    total += stock.quantity;
    if (!Number.isFinite(total)) {
      throw new Error("Storefront cart stock total is outside numeric bounds");
    }
  }
  return total;
}

function parseJsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

const productSelection = {
  id: true,
  slug: true,
  pancakeProductId: true,
  name: true,
  primaryImageUrl: true,
  isPresent: true,
  isActive: true,
  // I5 — server truth for the capacity rule. Read here rather than passed in, because "using
  // server truth" is the whole point of enforcing eligibility at this boundary: a client-supplied
  // policy would be exactly the browser-reported availability ADR 0014 §2 forbids.
  sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
  variants: {
    orderBy: [{ pancakeVariationId: "asc" as const }],
    select: {
      id: true,
      pancakeVariationId: true,
      isPresent: true,
      isActive: true,
      color: true,
      size: true,
      pancakeRetailPrice: true,
      pancakeRetailPriceAfterDiscount: true,
      pancakeImageUrls: true,
      warehouseStocks: {
        orderBy: [{ pancakeWarehouseId: "asc" as const }],
        select: { quantity: true },
      },
      ...cartVariantCommerceSelection,
      // Whether this variant is a composite PARENT (it has components), which is the §11
      // restriction's subject — distinct from `compositeParents` below, which asks whether this
      // variant is somebody else's component.
      compositeComponents: {
        ...compositeSubSetAuthorityComponentSelection,
        select: {
          ...compositeSubSetAuthorityComponentSelection.select,
          quantity: true,
          componentVariant: {
            select: {
              // PR #81 — SET VÁY / SET QUẦN authority reads each component's combos; the shared
              // fragment keeps this path, PDP discovery and the checkout snapshot on one rule.
              ...compositeSubSetAuthorityComponentSelection.select.componentVariant.select,
              isPresent: true,
              product: {
                select: {
                  pancakeShopId: true,
                  isPresent: true,
                },
              },
              warehouseStocks: {
                orderBy: [{ pancakeWarehouseId: "asc" as const }],
                select: { quantity: true },
              },
            },
          },
        },
      },

    },
  },
} satisfies Prisma.ProductMirrorSelect;

type SelectedProduct = Prisma.ProductMirrorGetPayload<{ select: typeof productSelection }>;

/**
 * The capacity resources each variant's advisory figure reads: a composite parent its components,
 * a standalone variant itself — the same resources `reserveOrderCapacity()` would hold.
 */
function capacityResourceIds(products: readonly SelectedProduct[]): string[] {
  return products.flatMap((product) =>
    product.variants.flatMap((variant) =>
      variant.compositeComponents.length > 0
        ? variant.compositeComponents.map((edge) => edge.componentVariantId)
        : [variant.id],
    ),
  );
}

function toCartProduct(
  product: SelectedProduct,
  shopId: number,
  heldByVariantId: ReadonlyMap<string, number>,
) {
  const sellingPolicy = resolveSellingPolicy(product.sellingPolicy);
  return {
    slug: product.slug,
    pancakeProductId: product.pancakeProductId,
    name: product.name,
    primaryImageUrl: product.primaryImageUrl,
    isPresent: product.isPresent,
    isActive: product.isActive,
    // Absent resolves to the approved missing-row answer inside `buildStorefrontCartLines`, which
    // is the same single producer §5.1 requires rather than a second opinion invented here.
    sellingPolicy: product.sellingPolicy ?? undefined,
    // Product-level, matching I2's admin refusal and I6a's reservation check: if any variant has
    // components, the product is a composite parent for §11's purposes.
    isComposite: product.variants.some((variant) => variant.compositeComponents.length > 0),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      isPresent: variant.isPresent,
      isActive: variant.isActive,
      ...resolveCartVariantCommerceFlags(product.isPresent, variant),
      color: variant.color,
      size: variant.size,
      // The advisory capacity read model (`capacity-advisory.ts`): mirrored stock less the units
      // other orders still hold, so a line the reservation would refuse is not shown as buyable.
      sellableStock:
        variant.compositeComponents.length > 0
          ? deriveCompositeSellableStock({
              shopId,
              components: variant.compositeComponents.map((edge) => ({
                requiredQuantity: edge.quantity,
                activeReservedQuantity: heldByVariantId.get(edge.componentVariantId) ?? 0,
                componentVariant: edge.componentVariant,
              })),
            })
          : sumWarehouseStocks(variant.warehouseStocks) - (heldByVariantId.get(variant.id) ?? 0),
      compositeCapacity:
        variant.compositeComponents.length > 0
          ? deriveCompositeCapacitySnapshot({
              shopId,
              components: variant.compositeComponents.map((edge) => ({
                requiredQuantity: edge.quantity,
                activeReservedQuantity: heldByVariantId.get(edge.componentVariantId) ?? 0,
                componentVariant: edge.componentVariant,
              })),
              sellingMode: sellingPolicy.sellingMode,
              negativeStockLimit: sellingPolicy.negativeStockLimit,
            })
          : undefined,
      retailPrice: variant.pancakeRetailPrice,
      retailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
      imageUrls: parseJsonStringArray(variant.pancakeImageUrls),
    })),
  };
}

/**
 * The read surface this repository needs.
 *
 * Widened from `PrismaClient` to the structural minimum so the same resolution can run inside a
 * cart mutation's transaction. That is the point: the facts a mutation validates against and the
 * facts the cart page renders come from one projection, not two that can drift apart.
 */
export type StorefrontCartReadClient = Pick<Prisma.TransactionClient, "productMirror">
  & AdvisoryHoldReadClient
  & PromotionCandidateReadClient;

export function createStorefrontCartRepository(client: PrismaClient | StorefrontCartReadClient) {
  const readClient = client as StorefrontCartReadClient;

  /**
   * Resolves current cart lines against the central effective-price authority.
   *
   * Campaign candidates are read for every variant of every owning product, because the projection
   * prices the whole option set to decide mapping/ambiguity/stock — pricing only the requested ids
   * would leave the rest on a different rule. The lookup is batched at the candidate repository's
   * safety cap, so this stays a fixed small number of queries rather than one per line.
   *
   * Shared by `getLines` and `getQuote`; `onPricing` is passed only by the gated quote path, so the
   * legacy path runs exactly as before.
   */
  async function resolveCart({
    shopId,
    items,
    now,
    onPricing,
  }: {
    shopId: number;
    items: readonly CartItemIdentity[];
    now: Date;
    /** Observes the legacy resolver's answer per variant; used only by the gated quote path. */
    onPricing?: (variantId: string, pricing: PromotionPricingResult) => void;
  }) {
    const safeItems = parseItems(items);
    if (safeItems.length === 0) return null;

    const safeShopId = parseShopId(shopId);
    const variantIds = safeItems.map(({ variantId }) => variantId);
    const products = await readClient.productMirror.findMany({
      where: {
        pancakeShopId: safeShopId,
        variants: {
          some: {
            id: { in: variantIds },
          },
        },
      },
      select: productSelection,
    });

    const heldByVariantId = await readAdvisoryHeldQuantities(
      readClient,
      capacityResourceIds(products),
    );
    const cartProducts = products.map((product) =>
      toCartProduct(product, safeShopId, heldByVariantId),
    );
    const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
      variantIds: cartProducts.flatMap((product) =>
        product.variants.map((variant) => variant.id),
      ),
      client: readClient,
    });

    const lines = buildStorefrontCartLines({
      items: safeItems,
      products: cartProducts,
      pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now, onResolved: onPricing }),
    });
    const owners = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, { product, variant }] as const)));
    const trialPricing = buildPromotionalStorefrontPricing({ campaignsByVariantId, now });
    function canAddQuantity(addition: QuantityAddition): boolean {
      const future = items.map((item) => item.variantId === addition.variantId ? { ...item, quantity: item.quantity + addition.quantity } : item);
      if (!validateQuoteCartItems(future)) return false;
      // Match reservation ordering: STANDARD demand consumes shared resources before flexible lines.
      const ordered = [...future].sort((a, b) => {
        const aFlexible = resolveSellingPolicy(owners.get(a.variantId)?.product.sellingPolicy).sellingMode !== "STANDARD";
        const bFlexible = resolveSellingPolicy(owners.get(b.variantId)?.product.sellingPolicy).sellingMode !== "STANDARD";
        return Number(aFlexible) - Number(bFlexible) || a.variantId.localeCompare(b.variantId);
      });
      const pending = new Map(heldByVariantId);
      for (const item of ordered) {
        const owner = owners.get(item.variantId);
        if (!owner) return false;
        // The same quantity-aware projection handles STANDARD, PREORDER, OVERSELL and composites.
        // Include earlier paid demand so two combos/a standalone cannot spend the same component twice.
        const trial = buildStorefrontCartLines({ items: [item], products: [toCartProduct(owner.product, shopId, pending)], pricingRule: trialPricing });
        if (!trial[0]?.available) return false;
        const resources = owner.variant.compositeComponents.length
          ? owner.variant.compositeComponents.map((edge) => ({ id: edge.componentVariantId, quantity: edge.quantity * item.quantity }))
          : [{ id: item.variantId, quantity: item.quantity }];
        for (const resource of resources) pending.set(resource.id, (pending.get(resource.id) ?? 0) + resource.quantity);
      }
      return true;
    }
    // Lazy: only the cart surfaces ask for it; checkout and order paths never pay for it.
    const lineUrgency = () => lineUrgencyFrom(safeItems, cartProducts, campaignsByVariantId, now);
    return { lines, products, lineUrgency, canAddQuantity };
  }

  /**
   * Each line's Flash Sale countdown and "Còn x", from the very reads, campaigns and instant the lines
   * were just priced from: a countdown can never sit beside a price another snapshot decided, and no
   * second read is spent on it. Presentation only, so a failure here yields nothing rather than an error.
   */
  function lineUrgencyFrom(
    items: readonly CartItemIdentity[],
    cartProducts: Parameters<typeof buildCartLineUrgency>[0]["products"],
    campaignsByVariantId: Parameters<typeof buildCartLineUrgency>[0]["campaignsByVariantId"],
    now: Date,
  ): CartLineUrgency {
    try {
      return buildCartLineUrgency({ items, products: cartProducts, campaignsByVariantId, now });
    } catch {
      return Object.freeze({});
    }
  }

  async function getLines({
    shopId,
    items,
    now = new Date(),
  }: {
    shopId: number;
    items: readonly CartItemIdentity[];
    now?: Date;
  }) {
    const resolved = await resolveCart({ shopId, items, now });
    return resolved === null ? [] : resolved.lines;
  }

  /** `getLines` plus each line's countdown and "Còn x" from the same resolution, for the cart surfaces. */
  async function getLinesWithUrgency({
    shopId,
    items,
    now = new Date(),
  }: {
    shopId: number;
    items: readonly CartItemIdentity[];
    now?: Date;
  }): Promise<{ lines: Awaited<ReturnType<typeof getLines>>; lineUrgency?: CartLineUrgency }> {
    const resolved = await resolveCart({ shopId, items, now });
    return resolved === null ? { lines: [] } : { lines: resolved.lines, lineUrgency: resolved.lineUrgency() };
  }

  /**
   * The cart lines plus the cart-level quantity-tier benefits (GQ08).
   *
   * `lines` is exactly what `getLines` returns -- the legacy per-variant authority, unchanged, and
   * it is what every existing consumer keeps reading. The tier result is a separate field and
   * exists only while `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` is exactly `"true"`; with the gate OFF
   * `benefits` is `{ enabled: false }` and the path is `getLines` with nothing added: no gift or
   * quantity table is read and no extra statement is issued.
   *
   * When ON, only purchasable, priced lines take part (a line the buyer cannot buy has no paid
   * price to tier), and each is priced from the legacy answer the resolver already produced for
   * that very line, so the tier is stacked on exactly the price the cart shows. Everything is
   * re-derived from current facts on every call, so a quantity change simply re-runs it.
   */
  async function getQuote({
    shopId,
    items,
    now = new Date(),
    env = process.env,
    giftClient = readClient as unknown as GiftQuantityCandidateReadClient,
    readLegacyConsents = createLegacyConsentReader(readClient as unknown as Parameters<typeof createLegacyConsentReader>[0]),
    preservesQuantityGifts,
  }: {
    shopId: number;
    items: readonly CartItemIdentity[];
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
    giftClient?: GiftQuantityCandidateReadClient;
    readLegacyConsents?: LegacyConsentReader;
    preservesQuantityGifts?: QuantityGiftGuard;
  }) {
    if (!isGiftQuantityPromotionsEnabled(env)) {
      return { ...(await getLinesWithUrgency({ shopId, items, now })), benefits: { enabled: false as const } };
    }

    // The raw items are validated BEFORE anything is resolved or filtered: a duplicate variant, a
    // zero/negative/fractional quantity or an oversized cart must refuse the whole paid quote, not
    // quietly drop out as an "unavailable" line and leave a smaller, apparently valid subtotal.
    // Nothing is resolved for such input, so `lines` is empty alongside the refusal.
    if (!validateQuoteCartItems(items)) {
      return {
        lines: [] as Awaited<ReturnType<typeof getLines>>,
        benefits: { enabled: true as const, ok: false as const, reason: "INPUT_INVALID" as const },
      };
    }

    const pricingByVariantId = new Map<string, PromotionPricingResult>();
    const resolved = await resolveCart({
      shopId,
      items,
      now,
      onPricing: (variantId, pricing) => pricingByVariantId.set(variantId, pricing),
    });
    if (resolved === null) {
      const benefits = await resolveGiftQuantityQuote({ lines: [], now, client: giftClient, env, readLegacyConsents });
      return { lines: [] as Awaited<ReturnType<typeof getLines>>, benefits };
    }

    const productIdByVariantId = new Map<string, string>();
    for (const product of resolved.products) {
      for (const variant of product.variants) productIdByVariantId.set(variant.id, product.id);
    }

    const quoteLines: QuoteCartLine[] = [];
    let consistent = true;
    for (const line of resolved.lines) {
      if (!line.available || line.price === null || line.pancakeVariationId === null) continue;
      const productId = productIdByVariantId.get(line.variantId);
      const pricing = pricingByVariantId.get(line.variantId);
      // The line price IS the resolver's effective price for that variant. If the two ever differ
      // the quote refuses to build a stack on a price the cart is not showing.
      if (
        productId === undefined ||
        pricing === undefined ||
        pricing.effectivePriceVnd !== line.price ||
        !Number.isSafeInteger(pricing.basePriceVnd) ||
        pricing.basePriceVnd === null
      ) {
        consistent = false;
        break;
      }
      quoteLines.push({
        variantId: line.variantId,
        pancakeVariationId: line.pancakeVariationId,
        productId,
        quantity: line.quantity,
        basePriceVnd: pricing.basePriceVnd,
        legacy:
          pricing.isDiscounted && pricing.promotion !== null && pricing.effectivePriceVnd !== null
            ? { campaign: pricing.promotion, effectivePriceVnd: pricing.effectivePriceVnd }
            : null,
      });
    }
    if (!consistent) return { lines: resolved.lines, lineUrgency: resolved.lineUrgency(), benefits: { enabled: true as const, ok: false as const, reason: "INPUT_INVALID" as const } };

    const benefits = await resolveGiftQuantityQuote({
      lines: quoteLines,
      now,
      client: giftClient,
      env,
      readLegacyConsents,
      canAddQuantity: resolved.canAddQuantity,
      preservesQuantityGifts,
    });
    return { lines: resolved.lines, lineUrgency: resolved.lineUrgency(), benefits };
  }

  return { getLines, getLinesWithUrgency, getQuote };
}
