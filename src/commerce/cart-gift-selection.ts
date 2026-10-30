/** GQ12: cookie-owned choices, serialized with paid cart writes. No reservations or consent. */
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { readyGiftOptionStock, readyGiftResourceUnits } from "./gift-quantity-gift-option-capacity.ts";
import { MAX_MEDIA_CANDIDATES_SCANNED, parseTrustedProductImageUrl } from "./product-media.ts";
import { readAdvisoryHeldQuantities } from "./capacity-advisory.ts";
import { listCartGiftSelections, removeCartGiftSelection, setCartGiftSelection } from "./cart-gift-selection-repository.ts";
import { readActiveGiftQuantityCampaigns, readScopeProductFacts, type GiftQuantityCandidateReadClient } from "./gift-quantity-candidate-repository.ts";
import { evaluateGiftEntitlements, validateGiftSelections, type GiftCampaignFacts, type GiftSelectionLine } from "./gift-quantity-entitlement.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { resolveGiftCampaignStacking, supersededGiftCampaigns, type StackedGroup } from "./gift-quantity-stack.ts";
import type { QuantityAddition } from "./gift-quantity-quote.ts";
import { createStorefrontCartRepository, type StorefrontCartReadClient } from "./storefront-cart-repository.ts";

type CookieReader = { get(name: string): { value: string } | undefined };
export type GiftChoiceInput = Readonly<{ campaignId: string; variantId: string; quantity: number; campaignRevision: number }>;

/** Public payload has no cart identity, prices, scope, stock or entitlement supplied by the buyer. */
export function parseGiftChoice(input: unknown): GiftChoiceInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["campaignId", "variantId", "quantity", "campaignRevision"].includes(key))) return null;
  if (![r.campaignId, r.variantId].every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id))) return null;
  if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity < 0 || r.quantity > 100) return null;
  if (typeof r.campaignRevision !== "number" || !Number.isInteger(r.campaignRevision) || r.campaignRevision < 1 || r.campaignRevision > 2_147_483_647) return null;
  return r as GiftChoiceInput;
}

// Optional gift photography is best-effort: do not make cart/checkout transactions scan whole catalog families.
const MAX_GIFT_SIBLING_VARIANTS = 20;

function extractCandidateImageUrl(primaryImageUrl: string | null | undefined, pancakeImageUrls: unknown): string | null {
  // The gift's own variant photo wins; use the product primary only if its variant has none.
  if (Array.isArray(pancakeImageUrls)) {
    for (let index = 0; index < Math.min(pancakeImageUrls.length, MAX_MEDIA_CANDIDATES_SCANNED); index++) {
      const image = parseTrustedProductImageUrl(pancakeImageUrls[index]);
      if (image) return image;
    }
  }
  return parseTrustedProductImageUrl(primaryImageUrl);
}

/** Reconciliation reports only the units it removed in this cart read; it is not part of quote authority. */
export type CartGiftState = Awaited<ReturnType<typeof readCartGiftState>> & Readonly<{
  autoRemovedGiftCount?: number;
}>;

/**
 * How a gift variant is named to the shopper. `color` and `size` are the variant's own axes, kept
 * beside the joined label so the picker can order a product's options (sizes run S → M → L → XL)
 * instead of showing them in storage order. Optional: a label without them still renders.
 */
export type CartGiftLabel = Readonly<{
  variantId: string;
  productId: string;
  productName: string;
  imageUrl?: string | null;
  optionLabel: string;
  color?: string | null;
  size?: string | null;
}>;

/**
 * The cart's quote, entitlements and validated gift selection, read inside the caller's transaction.
 * Exported for the checkout DRAFT step (GQ17) so checkout prices a gift cart from the very same
 * facts the cart page showed, not from a second derivation that could drift.
 */
export async function readCartGiftState(tx: Prisma.TransactionClient, cartId: string, shopId: number, now: Date, env: Readonly<Record<string, string | undefined>>, paidItems?: readonly { variantId: string; quantity: number; sourceProductSlug?: string | null }[]) {
  const cart = paidItems === undefined
    ? await tx.cart.findUniqueOrThrow({ where: { id: cartId }, select: { items: { select: { variantId: true, quantity: true, sourceProductSlug: true } } } })
    : { items: paidItems };
  if (!isGiftQuantityPromotionsEnabled(env)) throw new Error("Quote unavailable");
  const paidVariants = await tx.variantMirror.findMany({ where: { id: { in: cart.items.map((item) => item.variantId) } }, select: { id: true, productId: true } });
  const productIds = [...new Set(paidVariants.map((variant) => variant.productId))];
  const client = tx as unknown as GiftQuantityCandidateReadClient;
  const lookup = await readActiveGiftQuantityCampaigns({ now, productIds, client, env });
  const entries = lookup.campaigns.filter((entry) => entry.campaign.kind === "GIFT_ITEM");
  const facts = await readScopeProductFacts({ productIds, client });
  const productByVariant = new Map(paidVariants.map((variant) => [variant.id, facts.find((fact) => fact.productId === variant.productId)!]));
  const ids = [...new Set(entries.flatMap((entry) => entry.campaign.giftOptions.map((option) => option.variantId)))];
  if (ids.length > 10_000) throw new Error("Options bound exceeded");
  const variants = await tx.variantMirror.findMany({
    where: { id: { in: ids }, product: { pancakeShopId: shopId } },
    orderBy: [{ productId: "asc" }, { pancakeVariationId: "asc" }, { id: "asc" }],
    select: {
      id: true, productId: true, color: true, size: true, isPresent: true, isActive: true, pancakeImageUrls: true,
      product: { select: { name: true, primaryImageUrl: true, pancakeShopId: true, isActive: true, isPresent: true } },
      warehouseStocks: { select: { quantity: true } },
      compositeComponents: {
        select: {
          componentVariantId: true,
          quantity: true,
          componentVariant: {
            select: {
              id: true,
              isPresent: true,
              isActive: true,
              product: { select: { pancakeShopId: true, isPresent: true, isActive: true } },
              warehouseStocks: { select: { quantity: true } },
            },
          },
        },
      },
    },
  });
  // Paid composite lines consume component stock, even when the gift is a standalone component.
  const edges = await tx.compositeComponentMirror.findMany({ where: { parentVariantId: { in: cart.items.map((item) => item.variantId) } }, select: { parentVariantId: true, componentVariantId: true, quantity: true } });
  const demand = new Map<string, number>();
  for (const item of cart.items) {
    const components = edges.filter((edge) => edge.parentVariantId === item.variantId);
    for (const resource of components.length ? components.map((edge) => ({ id: edge.componentVariantId, quantity: edge.quantity * item.quantity })) : [{ id: item.variantId, quantity: item.quantity }]) {
      demand.set(resource.id, (demand.get(resource.id) ?? 0) + resource.quantity);
    }
  }
  const allVariantIds = [
    ...new Set([
      ...ids,
      ...variants.flatMap((v) => v.compositeComponents.map((c) => c.componentVariantId)),
    ]),
  ];
  const held = await readAdvisoryHeldQuantities(tx, allVariantIds);
  const unavailable = new Map(held);
  for (const [variantId, quantity] of demand) unavailable.set(variantId, (unavailable.get(variantId) ?? 0) + quantity);
  const optionById = new Map(variants.map((v) => {
    const composite = v.compositeComponents.length > 0;
    const resourceNeeds = composite
      ? v.compositeComponents.map((edge) => ({
          variantId: edge.componentVariantId,
          unitsPerGift: edge.quantity,
          availableUnits: edge.componentVariant.isPresent && edge.componentVariant.product.isPresent &&
            edge.componentVariant.product.pancakeShopId === shopId
            ? readyGiftResourceUnits(edge.componentVariant.warehouseStocks, unavailable.get(edge.componentVariantId) ?? 0) : 0,
        }))
      : [{ variantId: v.id, unitsPerGift: 1, availableUnits: readyGiftResourceUnits(v.warehouseStocks, unavailable.get(v.id) ?? 0) }];
    const readyAvailable = readyGiftOptionStock(v, unavailable);
    return [v.id, { variantId: v.id, productId: v.productId, composite, readyAvailable, resourceNeeds }] as const;
  }));
  const campaigns: GiftCampaignFacts[] = entries.map(({ campaign: c, scope, frozen }) => ({
    id: c.id, revision: c.revision, trigger: c.giftTrigger!, minimumQuantity: c.minimumQuantity,
    minimumSubtotalVnd: c.minimumSubtotalVnd, subtotalScope: c.subtotalScope, awardMode: c.awardMode,
    maxGiftsPerOrder: c.maxGiftsPerOrder, allowDuplicateGifts: c.allowDuplicateGifts as boolean, scope, frozen,
    options: c.giftOptions.flatMap((option) => optionById.has(option.variantId) ? [optionById.get(option.variantId)!] : []),
  }));
  const selections = await listCartGiftSelections(tx, cartId);
  // Use the same entitlement/stack/selection authority for today's cart and each proposed milestone.
  function evaluateGifts(groups: readonly StackedGroup[], addition?: QuantityAddition) {
    const components = addition ? edges.filter((edge) => edge.parentVariantId === addition.variantId) : [];
    const extraDemand = new Map(components.length
      ? components.map((edge) => [edge.componentVariantId, edge.quantity * addition!.quantity] as const)
      : addition ? [[addition.variantId, addition.quantity] as const] : []);
    const futureCampaigns = addition ? campaigns.map((campaign) => ({ ...campaign,
      options: campaign.options.map((option) => {
        const resources = option.resourceNeeds?.map((resource) => ({
          ...resource, availableUnits: Math.max(0, resource.availableUnits - (extraDemand.get(resource.variantId) ?? 0)),
        }));
        return {
          ...option,
          ...(resources ? { resourceNeeds: resources } : {}),
          readyAvailable: resources
            ? Math.min(option.readyAvailable, ...resources.map((resource) => Math.floor(resource.availableUnits / resource.unitsPerGift)))
            : Math.max(0, option.readyAvailable - (extraDemand.get(option.variantId) ?? 0)),
        };
      }),
    })) : campaigns;
    const evaluation = evaluateGiftEntitlements({ campaigns: futureCampaigns, paidGroups: groups.map((group) => ({ ...group, product: productByVariant.get(group.lineKey)! })) });
    if (!evaluation.ok) throw new Error("Invalid gift configuration");
    const earning = new Set(evaluation.entitlements.filter((entry) => entry.entitled > 0).map((entry) => entry.campaignId));
    const candidates = entries.filter((entry) => earning.has(entry.campaign.id)).map(({ campaign: c }) => ({
      id: c.id,
      stackingEnabled: c.stackingEnabled,
      peers: c.stackPeers.map((peer) => ({ kind: peer.peerKind, campaignId: peer.peerCampaignId })),
      minimumQuantity: c.minimumQuantity,
      minimumSubtotalVnd: c.minimumSubtotalVnd,
      stackPriority: c.stackPriority,
    }));
    const stack = resolveGiftCampaignStacking(candidates);
    const dropped = new Set(stack.dropped.map((entry) => entry.campaignId));
    const entitlements = evaluation.entitlements.map((entry) => dropped.has(entry.campaignId)
      ? { ...entry, entitled: 0, grantable: 0, unfulfillableForStock: 0, selectableOptions: [], shortfallToNext: null } : entry);
    // A choice of a lower milestone that a higher one replaced is kept (not erased), but neither blocks
    // the cart nor rides the order while the cart stays up there. Back at its own milestone it counts again.
    const superseded = supersededGiftCampaigns(candidates, stack);
    const active = selections.filter((row) => !superseded.has(row.campaignId));
    const replaced = selections.filter((row) => superseded.has(row.campaignId))
      .map((row) => ({ ...row, replacedByCampaignIds: superseded.get(row.campaignId)! }));
    return { entitlements, stack, superseded, active, replaced,
      validation: validateGiftSelections({ campaigns: futureCampaigns, entitlements, selection: active }) };
  }
  let currentGifts: ReturnType<typeof evaluateGifts> | undefined;
  const quote = await createStorefrontCartRepository(tx as unknown as StorefrontCartReadClient).getQuote({ shopId, items: cart.items, now, env,
    preservesQuantityGifts: ({ before, after, addition }) => {
      currentGifts ??= evaluateGifts(before);
      const future = evaluateGifts(after, addition);
      // A "+1" hint never trades away a gift the buyer already chose for another milestone's slot.
      const replacedNow = new Set(currentGifts.replaced.map((row) => `${row.campaignId}/${row.variantId}`));
      return future.validation.ok && future.replaced.every((row) => replacedNow.has(`${row.campaignId}/${row.variantId}`)) && (
        currentGifts.entitlements.every((entry) => {
          const next = future.entitlements.find((row) => row.campaignId === entry.campaignId);
          return next && next.entitled >= entry.entitled && next.grantable >= entry.grantable;
        }) ||
        future.entitlements.reduce((sum, e) => sum + e.entitled, 0) >= currentGifts.entitlements.reduce((sum, e) => sum + e.entitled, 0)
      );
    },
  });
  if (!quote.benefits.enabled || !quote.benefits.ok) throw new Error("Quote unavailable");
  const { entitlements, validation, stack, active, replaced, superseded } = currentGifts ?? evaluateGifts(quote.benefits.groups);
  const imageByVariantId = new Map<string, string>();
  const imageByProductId = new Map<string, string>();
  for (const v of variants) {
    const candidate = extractCandidateImageUrl(v.product.primaryImageUrl, v.pancakeImageUrls);
    if (!candidate) continue;
    imageByVariantId.set(v.id, candidate);
    if (!imageByProductId.has(v.productId)) imageByProductId.set(v.productId, candidate);
  }

  // Optional sibling fallback only if no offered variant or product primary contains trusted media.
  // Bound the read *in SQL*: 20 sibling variants and 100 total candidate URL strings per call.
  // JSON stays in PostgreSQL; the transaction never hydrates entire sibling image arrays.
  const missingProductIds = [...new Set(variants.map((v) => v.productId))].filter((id) => !imageByProductId.has(id));
  if (missingProductIds.length > 0) {
    const candidates = await tx.$queryRaw<{ productId: string; url: string }[]>`
      WITH siblings AS (
        SELECT v."id", v."productId", v."pancakeVariationId", v."pancakeImageUrls"
        FROM "VariantMirror" v
        WHERE v."productId" = ANY(${missingProductIds}::text[])
          AND NOT (v."id" = ANY(${ids}::text[]))
          AND v."isPresent" = TRUE
          AND v."isActive" = TRUE
        ORDER BY v."productId" ASC, v."pancakeVariationId" ASC, v."id" ASC
        LIMIT ${MAX_GIFT_SIBLING_VARIANTS}
      )
      SELECT siblings."productId", siblings."pancakeImageUrls" ->> image."index" AS "url"
      FROM siblings
      CROSS JOIN LATERAL generate_series(
        0,
        LEAST(
          CASE WHEN JSONB_TYPEOF(siblings."pancakeImageUrls") = 'array'
            THEN JSONB_ARRAY_LENGTH(siblings."pancakeImageUrls")
            ELSE 0 END,
          ${MAX_MEDIA_CANDIDATES_SCANNED}
        ) - 1
      ) AS image("index")
      WHERE JSONB_TYPEOF(siblings."pancakeImageUrls" -> image."index") = 'string'
      ORDER BY siblings."productId", siblings."pancakeVariationId", siblings."id", image."index"
      LIMIT ${MAX_MEDIA_CANDIDATES_SCANNED}
    `;
    for (const row of candidates) {
      if (imageByProductId.has(row.productId)) continue;
      const image = parseTrustedProductImageUrl(row.url);
      if (image) imageByProductId.set(row.productId, image);
    }
  }

  // `selections` are the choices that count for this cart; `replacedSelections` wait at a lower milestone.
  return { quote, campaigns, entitlements, selections: active, replacedSelections: replaced, validation, giftStackDropped: stack.dropped,
    // The same entitlement / stack / selection authority, on groups the caller priced differently (Voucher v1 asks
    // "what would the gifts be after this voucher" without a second derivation that could drift).
    evaluateGifts: (groups: readonly StackedGroup[]) => evaluateGifts(groups),
    giftSuperseded: [...superseded].map(([campaignId, byCampaignIds]) => ({ campaignId, byCampaignIds })),
    items: cart.items, paidDemand: demand, campaignEntries: lookup.campaigns, productFacts: facts, paidVariants,
    labels: variants.map((v): CartGiftLabel => ({
      variantId: v.id,
      productId: v.productId,
      productName: v.product.name,
      imageUrl: imageByVariantId.get(v.id) ?? imageByProductId.get(v.productId) ?? null,
      optionLabel: [v.color, v.size].filter(Boolean).join(" / "),
      color: v.color,
      size: v.size,
    })) };
}

/**
 * The locks a gift write takes, in the order every writer takes them: the anonymous cart row, then the
 * campaigns the buyer could earn from or already chose. `false` when the cart is gone or expired.
 */
async function lockCartForGiftWrite(tx: Prisma.TransactionClient, cartId: string, now: Date) {
  const carts = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Cart" WHERE "id" = ${cartId} AND "userId" IS NULL AND "expiresAt" > ${now} FOR UPDATE`;
  if (carts.length !== 1) return false;
  // Same rows Admin revises: no accepted choice can race a rule/revision edit.
  const campaigns = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GiftQuantityCampaign"
    WHERE ("isEnabled" = true AND ("startsAt" IS NULL OR "startsAt" <= ${now}) AND ("endsAt" IS NULL OR "endsAt" > ${now}))
      OR "id" IN (SELECT "campaignId" FROM "CartGiftSelection" WHERE "cartId" = ${cartId})
    ORDER BY "id" LIMIT 151 FOR SHARE`;
  if (campaigns.length > 150) throw new Error("Campaign bound exceeded");
  return true;
}

type ShrunkGiftEntitlement = Readonly<{ campaignId: string; revision: number; keepQuantity: number }>;

/**
 * Only retract choices when an active, unchanged gift campaign earned fewer units from
 * today's PAID basket than the buyer previously selected. A stack conflict, stock loss,
 * disabled/edited campaign or failed paid quote is NOT evidence of a voluntary basket reduction.
 * Those cases retain their existing manual-repair and fail-closed behavior.
 */
function shrunkGiftEntitlements(state: CartGiftState): readonly ShrunkGiftEntitlement[] {
  if (state.quote.lines.some((line) => !line.available)) return [];
  const dropped = new Set(state.giftStackDropped.map((row) => row.campaignId));
  return state.entitlements.flatMap((entitlement) => {
    if (dropped.has(entitlement.campaignId)) return [];
    const campaign = state.campaigns.find((row) => row.id === entitlement.campaignId);
    if (!campaign || campaign.revision !== entitlement.revision) return [];
    const choices = state.selections.filter((row) => row.campaignId === entitlement.campaignId);
    const selected = choices.reduce((sum, row) => sum + row.quantity, 0);
    if (choices.some((row) => row.campaignRevision !== entitlement.revision) ||
        selected <= entitlement.entitled || selected <= entitlement.earned) return [];
    return [{ campaignId: entitlement.campaignId, revision: entitlement.revision, keepQuantity: entitlement.entitled }];
  });
}

/**
 * Reduce only surplus gift units, keeping the buyer's oldest selections first. Deterministic
 * variant-id ties protect retries. Never select a replacement gift. The transaction already owns
 * the cart row and active campaign share locks; its rollback protects against partial cleanup.
 */
async function removeSurplusGiftUnits(
  tx: Prisma.TransactionClient, cartId: string, targets: readonly ShrunkGiftEntitlement[],
): Promise<number> {
  let removedUnits = 0;
  for (const target of targets) {
    const choices = await tx.cartGiftSelection.findMany({
      where: { cartId, campaignId: target.campaignId },
      select: { variantId: true, quantity: true, campaignRevision: true },
      orderBy: [{ createdAt: "asc" }, { variantId: "asc" }],
      take: 101,
    });
    if (choices.length > 100 || choices.some((row) => row.campaignRevision !== target.revision)) {
      throw new Error("Gift reconciliation cannot trust stored choices");
    }
    let remaining = target.keepQuantity;
    for (const choice of choices) {
      const keep = Math.min(choice.quantity, remaining);
      remaining -= keep;
      if (keep === choice.quantity) continue;
      if (keep > 0) {
        const saved = await setCartGiftSelection(tx, {
          cartId, campaignId: target.campaignId, variantId: choice.variantId,
          quantity: keep, campaignRevision: target.revision,
        });
        if (!saved.ok) throw new Error("Gift quantity reduction failed");
      } else {
        const result = await removeCartGiftSelection(tx, {
          cartId, campaignId: target.campaignId, variantId: choice.variantId,
        });
        if (!result.removed) throw new Error("Gift choice removal failed");
      }
      removedUnits += choice.quantity - keep;
    }
  }
  return removedUnits;
}

/**
 * Cart/checkout share a single authoritative read-and-reconcile boundary.
 * It retires replaced lower-milestone gifts (PR #226), and on an explicitly confirmed
 * paid-cart reduction withdraws only gift units the buyer no longer earns.
 *
 * Both changes take the same cart/campaign locks used by gift writes. Upward milestones
 * reconcile on read; downward cleanup requires a confirmed PAID decrease from a cart mutation.
 * No path ever chooses a different gift.
 */
export async function readReconciledCartGiftState(
  tx: Prisma.TransactionClient, cartId: string, shopId: number, now: Date,
  env: Readonly<Record<string, string | undefined>>,
  { locked = false, afterPaidReduction = false }: { locked?: boolean; afterPaidReduction?: boolean } = {},
): Promise<CartGiftState> {
  let state = await readCartGiftState(tx, cartId, shopId, now, env);
  if (state.replacedSelections.length === 0 && (!afterPaidReduction || shrunkGiftEntitlements(state).length === 0)) return state;
  if (!locked) {
    if (!await lockCartForGiftWrite(tx, cartId, now)) return state;
    // Another request may have reconciled while this one waited for the lock.
    state = await readCartGiftState(tx, cartId, shopId, now, env);
    if (state.replacedSelections.length === 0 && (!afterPaidReduction || shrunkGiftEntitlements(state).length === 0)) return state;
  }

  const kept: GiftSelectionLine[] = [...state.selections];
  const canTransfer = state.validation.ok && state.quote.lines.every((line) => line.available);
  for (const old of state.replacedSelections) {
    if (canTransfer) for (const higherId of old.replacedByCampaignIds) {
      const campaign = state.campaigns.find((row) => row.id === higherId);
      const entitlement = state.entitlements.find((row) => row.campaignId === higherId);
      if (!campaign || !entitlement || entitlement.entitled < 1 ||
        !campaign.options.some((option) => option.variantId === old.variantId && option.readyAvailable > 0)) continue;

      const candidate: GiftSelectionLine = {
        campaignId: higherId, variantId: old.variantId, quantity: old.quantity,
        campaignRevision: entitlement.revision,
      };
      if (!validateGiftSelections({ campaigns: state.campaigns, entitlements: state.entitlements,
        selection: [...kept, candidate] }).ok) continue;
      const saved = await setCartGiftSelection(tx, { cartId, ...candidate });
      if (!saved.ok) throw new Error("Gift milestone transfer failed");
      kept.push(candidate);
      break;
    }
    await removeCartGiftSelection(tx, { cartId, campaignId: old.campaignId, variantId: old.variantId });
  }
  const autoRemovedGiftCount = afterPaidReduction
    ? await removeSurplusGiftUnits(tx, cartId, shrunkGiftEntitlements(state)) : 0;
  // Re-evaluate from persisted state, never return the pre-cleanup selection or an old quote.
  const refreshed = await readCartGiftState(tx, cartId, shopId, now, env);
  return autoRemovedGiftCount > 0 ? { ...refreshed, autoRemovedGiftCount } : refreshed;
}

export function createCartGiftSelectionService(client: PrismaClient, store: CookieReader, { shopId, env = process.env }: { shopId: number; env?: Readonly<Record<string, string | undefined>> }) {
  async function withCart<T>(now: Date, work: (tx: Prisma.TransactionClient, cartId: string) => Promise<T>) {
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
    try {
      return await client.$transaction(async (tx) => {
        if (!await lockCartForGiftWrite(tx, cartId, now)) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
        return work(tx, cartId);
      });
    } catch {
      return { ok: false, reason: "LOOKUP_FAILED" } as const;
    }
  }

  async function get(now = new Date()) {
    if (!isGiftQuantityPromotionsEnabled(env)) return { enabled: false } as const;
    return withCart(now, async (tx, cartId) => ({ ok: true, state: await readReconciledCartGiftState(tx, cartId, shopId, now, env, { locked: true }) } as const));
  }

  /**
   * Called only after a confirmed paid-cart decrease/removal, never on a passive read.
   * Category sync, stock changes and Admin edits alone must not erase a buyer's gift.
   */
  async function reconcileAfterPaidReduction(now = new Date()) {
    if (!isGiftQuantityPromotionsEnabled(env)) return { enabled: false } as const;
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
    // Most cart edits have no chosen gifts. A bounded, cookie-scoped preflight avoids a
    // heavy quote and campaign locks in that common case. A concurrent new gift choice
    // must independently validate against the already committed paid cart.
    try {
      if (await client.cartGiftSelection.count({ where: { cartId } }) === 0) {
        return { ok: true, autoRemovedGiftCount: 0 } as const;
      }
    } catch {
      return { ok: false, reason: "LOOKUP_FAILED" } as const;
    }
    return withCart(now, async (tx, lockedCartId) => {
      const state = await readReconciledCartGiftState(tx, lockedCartId, shopId, now, env, {
        locked: true, afterPaidReduction: true,
      });
      return { ok: true, autoRemovedGiftCount: state.autoRemovedGiftCount ?? 0 } as const;
    });
  }

  async function set(input: unknown, now = new Date()) {
    const choice = parseGiftChoice(input);
    if (!choice) return { ok: false, reason: "INVALID_INPUT" } as const;
    if (!isGiftQuantityPromotionsEnabled(env)) return { ok: false, reason: "FEATURE_DISABLED" } as const;
    return withCart(now, async (tx, cartId) => {
      // Removal is explicit, idempotent, and allowed even when the campaign/paid cart is stale.
      if (choice.quantity === 0) {
        await removeCartGiftSelection(tx, { cartId, ...choice });
        return { ok: true } as const;
      }
      const state = await readCartGiftState(tx, cartId, shopId, now, env);
      if (state.quote.lines.some((line) => !line.available)) return { ok: false, reason: "SELECTION_INVALID" } as const;
      const selection: GiftSelectionLine[] = [...state.selections.filter((row) => row.campaignId !== choice.campaignId || row.variantId !== choice.variantId), choice];
      const validation = validateGiftSelections({ campaigns: state.campaigns, entitlements: state.entitlements, selection });
      if (!validation.ok) return { ok: false, reason: "SELECTION_INVALID" } as const;
      const result = await setCartGiftSelection(tx, { cartId, ...choice });
      if (!result.ok) return { ok: false, reason: "SELECTION_INVALID" } as const;
      // Taking a gift of the milestone that replaced an earlier choice is the buyer swapping it: the
      // replaced choice goes in the same transaction, so the cart never holds both.
      const swapped = state.replacedSelections.filter((row) => row.replacedByCampaignIds.includes(choice.campaignId));
      for (const row of swapped) await removeCartGiftSelection(tx, { cartId, campaignId: row.campaignId, variantId: row.variantId });
      return swapped.length > 0 ? { ok: true, replaced: swapped.reduce((sum, row) => sum + row.quantity, 0) } as const : { ok: true } as const;
    });
  }
  return { get, set, reconcileAfterPaidReduction };
}
