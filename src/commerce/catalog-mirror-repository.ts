import type { PrismaClient } from "../generated/prisma/client.ts";
import type {
  PancakeCatalogField,
  PancakeParsedCatalogVariation,
} from "../integrations/pancake/catalog-contract.ts";
import type { PancakeCompositeSnapshot } from "../integrations/pancake/composite-contract.ts";
import { observeVariantAvailabilityCycles } from "./availability-cycle-repository.ts";
import { resolveSellingPolicy } from "./capacity-policy.ts";
import {
  createBootstrapProductSlug,
  isLegacyOpaqueProductSlug,
  PRODUCT_SLUG_LOCK_NAMESPACE,
} from "./product-slug.ts";

const MAX_READ_PRODUCTS = 100;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_COMPOSITE_ENTRIES = 50_000;
const MAX_COMPOSITE_ID_LENGTH = 512;
const SYNC_LOCK_NAMESPACE = 1_277_934_572;
const SYNC_TRANSACTION_TIMEOUT_MS = 60_000;

type CatalogProductSnapshot = {
  pancakeProductId: string;
  name: string;
  sourceDescription: string | null;
  primaryImageUrl: string | null;
};

type VariantOptionMapping = {
  color: string | null;
  size: string | null;
};

function requireShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new TypeError("Catalog mirror shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

function requireSyncedAt(syncedAt: Date): Date {
  if (!(syncedAt instanceof Date) || Number.isNaN(syncedAt.getTime())) {
    throw new TypeError("Catalog mirror syncedAt must be a valid timestamp");
  }
  return syncedAt;
}

function parseReadLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_PRODUCTS) {
    throw new RangeError(`Catalog mirror read limit must be between 1 and ${MAX_READ_PRODUCTS}`);
  }
  return limit;
}

export function validateCatalogSnapshot(variations: readonly PancakeParsedCatalogVariation[]) {
  const productByExternalId = new Map<string, CatalogProductSnapshot>();
  const variationIds = new Set<string>();
  const productIdByVariationId = new Map<string, string>();

  for (const variation of variations) {
    if (variationIds.has(variation.id)) {
      throw new Error("Catalog mirror snapshot contains duplicate variation identity");
    }
    variationIds.add(variation.id);
    productIdByVariationId.set(variation.id, variation.productId);

    if (variation.product.id !== variation.productId) {
      throw new Error("Catalog mirror snapshot contains inconsistent canonical product identity");
    }

    const { sourceDescription, primaryImageUrl } = variation.product;

    const existingProduct = productByExternalId.get(variation.productId);
    if (
      existingProduct &&
      (existingProduct.name !== variation.product.name ||
        existingProduct.sourceDescription !== sourceDescription ||
        existingProduct.primaryImageUrl !== primaryImageUrl)
    ) {
      throw new Error("Catalog mirror snapshot contains inconsistent product presentation");
    }
    productByExternalId.set(variation.productId, {
      pancakeProductId: variation.productId,
      name: variation.product.name,
      sourceDescription,
      primaryImageUrl,
    });

    const warehouseIds = new Set<string>();
    let sellableStock = 0;
    for (const stock of variation.warehouseStocks) {
      if (warehouseIds.has(stock.warehouseId)) {
        throw new Error("Catalog mirror snapshot contains duplicate warehouse identity");
      }
      warehouseIds.add(stock.warehouseId);
      if (!Number.isFinite(stock.remainQuantity)) {
        throw new Error("Catalog mirror snapshot contains malformed warehouse quantity");
      }
      sellableStock += stock.remainQuantity;
      if (!Number.isFinite(sellableStock)) {
        throw new Error("Catalog mirror snapshot stock total is outside numeric bounds");
      }
    }
    if (sellableStock !== variation.sellableStock) {
      throw new Error("Catalog mirror snapshot contains inconsistent sellable stock aggregation");
    }
  }

  return { productByExternalId, variationIds, productIdByVariationId };
}

function isBoundedCompositeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_COMPOSITE_ID_LENGTH &&
    value === value.trim()
  );
}

function validateCompositeSnapshotAgainstCatalog(
  snapshot: PancakeCompositeSnapshot,
  productIdByVariationId: ReadonlyMap<string, string>,
): void {
  const fail = () => {
    throw new Error("Catalog composite snapshot is invalid");
  };
  if (
    !Array.isArray(snapshot.parentVariationIds) ||
    !Array.isArray(snapshot.componentVariationIds) ||
    !Array.isArray(snapshot.parentIdentities) ||
    !Array.isArray(snapshot.componentIdentities) ||
    !Array.isArray(snapshot.edges) ||
    snapshot.parentVariationIds.length > MAX_COMPOSITE_ENTRIES ||
    snapshot.componentVariationIds.length > MAX_COMPOSITE_ENTRIES ||
    snapshot.parentIdentities.length > MAX_COMPOSITE_ENTRIES ||
    snapshot.componentIdentities.length > MAX_COMPOSITE_ENTRIES ||
    snapshot.edges.length > MAX_COMPOSITE_ENTRIES
  ) {
    fail();
  }

  const parents = new Set<string>();
  const components = new Set<string>();
  for (const id of snapshot.parentVariationIds) {
    if (
      !isBoundedCompositeIdentity(id) ||
      parents.has(id) ||
      !productIdByVariationId.has(id)
    ) {
      fail();
    }
    parents.add(id);
  }
  for (const id of snapshot.componentVariationIds) {
    if (
      !isBoundedCompositeIdentity(id) ||
      components.has(id) ||
      parents.has(id) ||
      !productIdByVariationId.has(id)
    ) {
      fail();
    }
    components.add(id);
  }

  if (
    snapshot.parentIdentities.length !== parents.size ||
    snapshot.componentIdentities.length !== components.size
  ) {
    fail();
  }

  const validatedParents = new Set<string>();
  for (const identity of snapshot.parentIdentities) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      !isBoundedCompositeIdentity(identity.variationId) ||
      !isBoundedCompositeIdentity(identity.productId) ||
      !parents.has(identity.variationId) ||
      validatedParents.has(identity.variationId) ||
      productIdByVariationId.get(identity.variationId) !== identity.productId
    ) {
      fail();
    }
    validatedParents.add(identity.variationId);
  }

  const validatedComponents = new Set<string>();
  for (const identity of snapshot.componentIdentities) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      !isBoundedCompositeIdentity(identity.variationId) ||
      !isBoundedCompositeIdentity(identity.productId) ||
      !components.has(identity.variationId) ||
      validatedComponents.has(identity.variationId) ||
      productIdByVariationId.get(identity.variationId) !== identity.productId
    ) {
      fail();
    }
    validatedComponents.add(identity.variationId);
  }

  const pairs = new Set<string>();
  const parentsWithEdges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (
      edge === null ||
      typeof edge !== "object" ||
      !parents.has(edge.parentVariationId) ||
      !components.has(edge.componentVariationId) ||
      edge.parentVariationId === edge.componentVariationId ||
      !Number.isSafeInteger(edge.quantity) ||
      edge.quantity <= 0 ||
      edge.quantity > MAX_POSTGRES_INTEGER
    ) {
      fail();
    }
    const pair = `${edge.parentVariationId}\u0000${edge.componentVariationId}`;
    if (pairs.has(pair)) fail();
    pairs.add(pair);
    parentsWithEdges.add(edge.parentVariationId);
  }

  for (const parentVariationId of parents) {
    if (!parentsWithEdges.has(parentVariationId)) fail();
  }
}

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) {
      throw new Error("Catalog mirror contains malformed warehouse quantity");
    }
    total += stock.quantity;
    if (!Number.isFinite(total)) {
      throw new Error("Catalog mirror stock total is outside numeric bounds");
    }
  }
  return total;
}

function normalizedFieldDimension(name: string): "color" | "size" | null {
  const normalized = name.trim().toLowerCase();
  if (normalized === "size") return "size";
  if (normalized === "color" || normalized === "màu") return "color";
  return null;
}

function mappedFieldValue(fields: readonly PancakeCatalogField[], key: "color" | "size"): string | null {
  const values = new Set<string>();

  for (const field of fields) {
    if (normalizedFieldDimension(field.name) !== key) continue;
    const value = field.value.trim();
    if (value.length > 0) values.add(value);
  }

  return values.size === 1 ? [...values][0]! : null;
}

function mapVariantOptions(fields: readonly PancakeCatalogField[]): VariantOptionMapping {
  return {
    color: mappedFieldValue(fields, "color"),
    size: mappedFieldValue(fields, "size"),
  };
}

export function createCatalogMirrorRepository(client: PrismaClient) {
  async function syncSnapshot({
    shopId,
    variations,
    compositeSnapshot,
    syncedAt,
  }: {
    shopId: number;
    variations: readonly PancakeParsedCatalogVariation[];
    compositeSnapshot?: PancakeCompositeSnapshot;
    syncedAt: Date;
  }) {
    const safeShopId = requireShopId(shopId);
    const safeSyncedAt = requireSyncedAt(syncedAt);
    const { productByExternalId, variationIds, productIdByVariationId } =
      validateCatalogSnapshot(variations);
    if (compositeSnapshot !== undefined) {
      validateCompositeSnapshotAgainstCatalog(compositeSnapshot, productIdByVariationId);
    }
    const productIds = [...productByExternalId.keys()];
    const variationIdList = [...variationIds];

    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, ${safeShopId})`;

        if (compositeSnapshot === undefined) {
          const persistedComposite = await tx.compositeComponentMirror.findFirst({
            where: {
              OR: [
                { parentVariant: { product: { pancakeShopId: safeShopId } } },
                { componentVariant: { product: { pancakeShopId: safeShopId } } },
              ],
            },
            select: { parentVariantId: true },
          });
          if (persistedComposite) {
            throw new Error(
              "Catalog composite snapshot is required for a shop with persisted composite relationships",
            );
          }
        }

        // Product slug ownership spans the current-slug and history tables. Serialize
        // sync bootstrap/healing with explicit admin slug changes so a historical slug
        // cannot race back into use as a current slug.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRODUCT_SLUG_LOCK_NAMESPACE}, 0)`;

        // ProductMirror rows created before C4 had no shop scope. The C4 migration
        // uses shop 0 as the legacy sentinel, and the runtime currently has one
        // configured Pancake shop, so adopt those rows before stale reconciliation.
        await tx.productMirror.updateMany({
          where: { pancakeShopId: 0 },
          data: { pancakeShopId: safeShopId },
        });

        const syncState = await tx.catalogSyncState.findUnique({
          where: { pancakeShopId: safeShopId },
          select: { syncedAt: true },
        });
        if (syncState && syncState.syncedAt.getTime() > safeSyncedAt.getTime()) {
          throw new Error("Catalog mirror snapshot is older than the committed mirror");
        }

        const internalProductIds = new Map<string, string>();

        for (const product of productByExternalId.values()) {
          const existing = await tx.productMirror.findUnique({
            where: { pancakeProductId: product.pancakeProductId },
            select: { id: true, slug: true },
          });

          const mirrored = existing
            ? await (async () => {
                if (!isLegacyOpaqueProductSlug(existing.slug)) {
                  return tx.productMirror.update({
                    where: { id: existing.id },
                    data: {
                      pancakeShopId: safeShopId,
                      name: product.name,
                      sourceDescription: product.sourceDescription,
                      primaryImageUrl: product.primaryImageUrl,
                      isPresent: true,
                      syncedAt: safeSyncedAt,
                    },
                    select: { id: true },
                  });
                }

                // Rolling compatibility: an old runtime may create a p-<digest>
                // product after the migration has already backfilled existing rows.
                // The exact legacy pattern is reserved, so the new runtime can heal
                // only those rows without ever rewriting a normal website-owned slug.
                const readableSlug = createBootstrapProductSlug({
                  shopId: safeShopId,
                  pancakeProductId: product.pancakeProductId,
                  name: product.name,
                });
                const [currentOwner, candidateHistory, legacyHistory] = await Promise.all([
                  tx.productMirror.findUnique({
                    where: { slug: readableSlug },
                    select: { id: true },
                  }),
                  tx.productSlugHistory.findUnique({
                    where: { slug: readableSlug },
                    select: { productId: true },
                  }),
                  tx.productSlugHistory.findUnique({
                    where: { slug: existing.slug },
                    select: { productId: true },
                  }),
                ]);

                if (currentOwner || candidateHistory) {
                  throw new Error("Catalog mirror readable slug is already reserved");
                }
                if (legacyHistory && legacyHistory.productId !== existing.id) {
                  throw new Error("Catalog mirror legacy slug history has conflicting ownership");
                }
                if (!legacyHistory) {
                  await tx.productSlugHistory.create({
                    data: { slug: existing.slug, productId: existing.id },
                  });
                }

                return tx.productMirror.update({
                  where: { id: existing.id },
                  data: {
                    pancakeShopId: safeShopId,
                    slug: readableSlug,
                    name: product.name,
                    sourceDescription: product.sourceDescription,
                    primaryImageUrl: product.primaryImageUrl,
                    isPresent: true,
                    syncedAt: safeSyncedAt,
                  },
                  select: { id: true },
                });
              })()
            : await (async () => {
                const slug = createBootstrapProductSlug({
                  shopId: safeShopId,
                  pancakeProductId: product.pancakeProductId,
                  name: product.name,
                });
                const [currentOwner, historicalOwner] = await Promise.all([
                  tx.productMirror.findUnique({ where: { slug }, select: { id: true } }),
                  tx.productSlugHistory.findUnique({
                    where: { slug },
                    select: { productId: true },
                  }),
                ]);
                if (currentOwner || historicalOwner) {
                  throw new Error("Catalog mirror bootstrap slug is already reserved");
                }

                return tx.productMirror.create({
                  data: {
                    pancakeShopId: safeShopId,
                    pancakeProductId: product.pancakeProductId,
                    slug,
                    name: product.name,
                    sourceDescription: product.sourceDescription,
                    primaryImageUrl: product.primaryImageUrl,
                    isPresent: true,
                    isActive: false,
                    syncedAt: safeSyncedAt,
                  },
                  select: { id: true },
                });
              })();
          internalProductIds.set(product.pancakeProductId, mirrored.id);
        }

        const internalVariantIds = new Map<string, string>();
        for (const variation of variations) {
          const internalProductId = internalProductIds.get(variation.productId);
          if (!internalProductId) {
            throw new Error("Catalog mirror product identity could not be resolved");
          }
          const optionMapping = mapVariantOptions(variation.fields);

          const mirrored = await tx.variantMirror.upsert({
            where: { pancakeVariationId: variation.id },
            create: {
              pancakeVariationId: variation.id,
              productId: internalProductId,
              pancakeDisplayId: variation.displayId,
              pancakeBarcode: variation.barcode,
              pancakeFields: variation.fields,
              pancakeImageUrls: variation.imageUrls,
              pancakeIsHidden: variation.isHidden,
              pancakeIsLocked: variation.isLocked,
              pancakeRetailPrice: variation.retailPrice,
              pancakeRetailPriceAfterDiscount: variation.retailPriceAfterDiscount,
              color: optionMapping.color,
              size: optionMapping.size,
              isPresent: true,
              isActive: false,
              syncedAt: safeSyncedAt,
            },
            update: {
              productId: internalProductId,
              pancakeDisplayId: variation.displayId,
              pancakeBarcode: variation.barcode,
              pancakeFields: variation.fields,
              pancakeImageUrls: variation.imageUrls,
              pancakeIsHidden: variation.isHidden,
              pancakeIsLocked: variation.isLocked,
              pancakeRetailPrice: variation.retailPrice,
              pancakeRetailPriceAfterDiscount: variation.retailPriceAfterDiscount,
              color: optionMapping.color,
              size: optionMapping.size,
              isPresent: true,
              syncedAt: safeSyncedAt,
            },
            select: { id: true },
          });
          internalVariantIds.set(variation.id, mirrored.id);

          const currentWarehouseIds = variation.warehouseStocks.map(({ warehouseId }) => warehouseId);
          await tx.warehouseStock.deleteMany({
            where: {
              variantId: mirrored.id,
              ...(currentWarehouseIds.length > 0
                ? { pancakeWarehouseId: { notIn: currentWarehouseIds } }
                : {}),
            },
          });

          for (const stock of variation.warehouseStocks) {
            await tx.warehouseStock.upsert({
              where: {
                variantId_pancakeWarehouseId: {
                  variantId: mirrored.id,
                  pancakeWarehouseId: stock.warehouseId,
                },
              },
              create: {
                variantId: mirrored.id,
                pancakeWarehouseId: stock.warehouseId,
                quantity: stock.remainQuantity,
                syncedAt: safeSyncedAt,
              },
              update: {
                quantity: stock.remainQuantity,
                syncedAt: safeSyncedAt,
              },
            });
          }
        }

        if (compositeSnapshot !== undefined) {
          const shopVariants = await tx.variantMirror.findMany({
            where: { product: { pancakeShopId: safeShopId } },
            select: { id: true },
          });
          const shopVariantIds = shopVariants.map(({ id }) => id);
          if (shopVariantIds.length > 0) {
            await tx.compositeComponentMirror.deleteMany({
              where: {
                OR: [
                  { parentVariantId: { in: shopVariantIds } },
                  { componentVariantId: { in: shopVariantIds } },
                ],
              },
            });
          }

          if (compositeSnapshot.edges.length > 0) {
            const edgeRows = compositeSnapshot.edges.map((edge) => {
              const parentVariantId = internalVariantIds.get(edge.parentVariationId);
              const componentVariantId = internalVariantIds.get(edge.componentVariationId);
              if (!parentVariantId || !componentVariantId) {
                throw new Error("Catalog composite snapshot identity could not be resolved");
              }
              return {
                parentVariantId,
                componentVariantId,
                quantity: edge.quantity,
                syncedAt: safeSyncedAt,
              };
            });
            await tx.compositeComponentMirror.createMany({ data: edgeRows });
          }
        }

        const shopProducts = await tx.productMirror.findMany({
          where: { pancakeShopId: safeShopId },
          select: { id: true, pancakeProductId: true },
        });
        const shopProductIds = shopProducts.map(({ id }) => id);

        const staleVariants =
          shopProductIds.length === 0
            ? []
            : await tx.variantMirror.findMany({
                where: {
                  productId: { in: shopProductIds },
                  ...(variationIdList.length > 0
                    ? { pancakeVariationId: { notIn: variationIdList } }
                    : {}),
                },
                select: { id: true },
              });
        const staleVariantIds = staleVariants.map(({ id }) => id);
        if (staleVariantIds.length > 0) {
          await tx.warehouseStock.deleteMany({ where: { variantId: { in: staleVariantIds } } });
          await tx.variantMirror.updateMany({
            where: { id: { in: staleVariantIds } },
            data: { isPresent: false, isActive: false, syncedAt: safeSyncedAt },
          });
        }

        const staleProducts = shopProducts.filter(
          ({ pancakeProductId }) => !productByExternalId.has(pancakeProductId),
        );
        const staleProductIds = staleProducts.map(({ id }) => id);
        if (staleProductIds.length > 0) {
          await tx.variantMirror.updateMany({
            where: { productId: { in: staleProductIds } },
            data: { isPresent: false, isActive: false, syncedAt: safeSyncedAt },
          });
          await tx.productMirror.updateMany({
            where: { id: { in: staleProductIds } },
            data: { isPresent: false, isActive: false, syncedAt: safeSyncedAt },
          });
        }

        // I9 — the trusted stock observation, which is where a preorder availability cycle opens
        // and closes (ADR 0011, owner-approved 2026-09-18).
        //
        // Here rather than at read time on purpose: a date that a page render or a feed run could
        // open would depend on who happened to look, and two readers could disagree. The catalog
        // sync is the one place the website learns what Pancake's stock actually is, so it is the
        // one place allowed to move a cycle. Inside this transaction, so a sync that rolls back
        // leaves no cycle claiming a stock state that was never committed.
        //
        // The selling policy is read per product because a cycle depends on BOTH halves — stock
        // and mode — and only one of them arrives with the catalog.
        const observedProductIds = [...internalProductIds.values()];
        const storedPolicies =
          observedProductIds.length > 0
            ? await tx.productSellingPolicy.findMany({
                where: { productId: { in: observedProductIds } },
                select: { productId: true, sellingMode: true, negativeStockLimit: true },
              })
            : [];
        const policyByProductId = new Map(storedPolicies.map((row) => [row.productId, row]));

        const availabilityObservations = variations.flatMap((variation) => {
          const variantId = internalVariantIds.get(variation.id);
          const productId = internalProductIds.get(variation.productId);
          if (variantId === undefined || productId === undefined) return [];
          const policy = resolveSellingPolicy(policyByProductId.get(productId) ?? null);
          const stock = sumWarehouseStocks(
            variation.warehouseStocks.map(({ remainQuantity }) => ({ quantity: remainQuantity })),
          );
          // An unreadable total is not an observation of being sold out. Treating `NaN <= 0` as a
          // sell-out would open a cycle — and publish a date — off a number the catalog could not
          // read, so it is reported as having stock and the feed's own fail-closed path handles it.
          const stockNonPositive = Number.isFinite(stock) && stock <= 0;
          return [
            {
              variantId,
              stockNonPositive,
              isPreorder: policy.sellingMode === "PREORDER",
            },
          ];
        });
        await observeVariantAvailabilityCycles(tx, availabilityObservations, safeSyncedAt);

        await tx.catalogSyncState.upsert({
          where: { pancakeShopId: safeShopId },
          create: { pancakeShopId: safeShopId, syncedAt: safeSyncedAt },
          update: { syncedAt: safeSyncedAt },
        });

        return {
          products: productIds.length,
          variations: variationIdList.length,
        };
      },
      { timeout: SYNC_TRANSACTION_TIMEOUT_MS },
    );
  }

  async function listPresentProducts({ shopId, limit }: { shopId: number; limit: number }) {
    const products = await client.productMirror.findMany({
      where: { pancakeShopId: requireShopId(shopId), isPresent: true },
      take: parseReadLimit(limit),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        pancakeProductId: true,
        slug: true,
        name: true,
        sourceDescription: true,
        primaryImageUrl: true,
        isActive: true,
        syncedAt: true,
        variants: {
          where: { isPresent: true },
          orderBy: [{ pancakeVariationId: "asc" }],
          select: {
            id: true,
            pancakeVariationId: true,
            pancakeDisplayId: true,
            pancakeBarcode: true,
            pancakeFields: true,
            pancakeImageUrls: true,
            pancakeIsHidden: true,
            pancakeIsLocked: true,
            pancakeRetailPrice: true,
            pancakeRetailPriceAfterDiscount: true,
            sku: true,
            color: true,
            size: true,
            isActive: true,
            syncedAt: true,
            warehouseStocks: {
              orderBy: [{ pancakeWarehouseId: "asc" }],
              select: {
                pancakeWarehouseId: true,
                quantity: true,
              },
            },
          },
        },
      },
    });

    return products.map((product) => ({
      ...product,
      variants: product.variants.map((variant) => ({
        ...variant,
        sellableStock: sumWarehouseStocks(variant.warehouseStocks),
      })),
    }));
  }

  return { syncSnapshot, listPresentProducts };
}
