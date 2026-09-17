import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import type { PromotionCandidateReadClient } from "./promotion-candidate-repository.ts";
import { buildStorefrontCartLines } from "./storefront-cart.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

type CartItemIdentity = {
  variantId: string;
  quantity: number;
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
      // Whether this variant is a composite PARENT (it has components), which is the §11
      // restriction's subject — distinct from `compositeParents` below, which asks whether this
      // variant is somebody else's component.
      compositeComponents: { select: { parentVariantId: true }, take: 1 },
      compositeParents: {
        select: {
          parentVariant: {
            select: {
              isPresent: true,
              isActive: true,
              product: {
                select: {
                  isPresent: true,
                  isActive: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductMirrorSelect;

type SelectedProduct = Prisma.ProductMirrorGetPayload<{ select: typeof productSelection }>;

function toCartProduct(product: SelectedProduct) {
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
      isCompositeComponentAvailable: variant.compositeParents.some(
        ({ parentVariant }) =>
          parentVariant.isPresent &&
          parentVariant.isActive &&
          parentVariant.product.isPresent &&
          parentVariant.product.isActive,
      ),
      color: variant.color,
      size: variant.size,
      sellableStock: sumWarehouseStocks(variant.warehouseStocks),
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
   */
  async function getLines({
    shopId,
    items,
    now = new Date(),
  }: {
    shopId: number;
    items: readonly CartItemIdentity[];
    now?: Date;
  }) {
    const safeItems = parseItems(items);
    if (safeItems.length === 0) return [];

    const variantIds = safeItems.map(({ variantId }) => variantId);
    const products = await readClient.productMirror.findMany({
      where: {
        pancakeShopId: parseShopId(shopId),
        variants: {
          some: {
            id: { in: variantIds },
          },
        },
      },
      select: productSelection,
    });

    const cartProducts = products.map(toCartProduct);
    const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
      variantIds: cartProducts.flatMap((product) =>
        product.variants.map((variant) => variant.id),
      ),
      client: readClient,
    });

    return buildStorefrontCartLines({
      items: safeItems,
      products: cartProducts,
      pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
    });
  }

  return { getLines };
}
