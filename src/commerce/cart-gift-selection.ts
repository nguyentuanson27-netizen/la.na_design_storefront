/** GQ12: cookie-owned choices, serialized with paid cart writes. No reservations or consent. */
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { readAdvisoryHeldQuantities } from "./capacity-advisory.ts";
import { listCartGiftSelections, removeCartGiftSelection, setCartGiftSelection } from "./cart-gift-selection-repository.ts";
import { readActiveGiftQuantityCampaigns, readScopeProductFacts, type GiftQuantityCandidateReadClient } from "./gift-quantity-candidate-repository.ts";
import { evaluateGiftEntitlements, validateGiftSelections, type GiftCampaignFacts, type GiftSelectionLine } from "./gift-quantity-entitlement.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
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

export type CartGiftState = Awaited<ReturnType<typeof readState>>;

async function readState(tx: Prisma.TransactionClient, cartId: string, shopId: number, now: Date, env: Readonly<Record<string, string | undefined>>) {
  const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartId }, select: { items: { select: { variantId: true, quantity: true, sourceProductSlug: true } } } });
  const quote = await createStorefrontCartRepository(tx as unknown as StorefrontCartReadClient).getQuote({ shopId, items: cart.items, now, env });
  if (!quote.benefits.enabled || !quote.benefits.ok) throw new Error("Quote unavailable");
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
    select: { id: true, productId: true, color: true, size: true, isPresent: true, isActive: true,
      product: { select: { name: true, isActive: true, isPresent: true } },
      warehouseStocks: { select: { quantity: true } }, compositeComponents: { select: { componentVariantId: true } } },
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
  const held = await readAdvisoryHeldQuantities(tx, ids);
  const optionById = new Map(variants.map((v) => {
    const active = v.isActive && v.isPresent && v.product.isActive && v.product.isPresent;
    const stock = v.warehouseStocks.reduce((sum, row) => sum + row.quantity, 0) - (held.get(v.id) ?? 0) - (demand.get(v.id) ?? 0);
    // Gifts use READY stock only; preorder/oversell capacity cannot authorize a gift.
    const readyAvailable = active && Number.isSafeInteger(stock) ? Math.max(0, stock) : 0;
    return [v.id, { variantId: v.id, productId: v.productId, composite: v.compositeComponents.length > 0, readyAvailable }] as const;
  }));
  const campaigns: GiftCampaignFacts[] = entries.map(({ campaign: c, scope, frozen }) => ({
    id: c.id, revision: c.revision, trigger: c.giftTrigger!, minimumQuantity: c.minimumQuantity,
    minimumSubtotalVnd: c.minimumSubtotalVnd, subtotalScope: c.subtotalScope, awardMode: c.awardMode,
    maxGiftsPerOrder: c.maxGiftsPerOrder, allowDuplicateGifts: c.allowDuplicateGifts as boolean, scope, frozen,
    options: c.giftOptions.flatMap((option) => optionById.has(option.variantId) ? [optionById.get(option.variantId)!] : []),
  }));
  const evaluation = evaluateGiftEntitlements({ campaigns, paidGroups: quote.benefits.groups.map((group) => ({ ...group, product: productByVariant.get(group.lineKey)! })) });
  if (!evaluation.ok) throw new Error("Invalid gift configuration");
  const selections = await listCartGiftSelections(tx, cartId);
  const validation = validateGiftSelections({ campaigns, entitlements: evaluation.entitlements, selection: selections });
  return { quote, campaigns, entitlements: evaluation.entitlements, selections, validation,
    labels: variants.map((v) => ({ variantId: v.id, productId: v.productId, productName: v.product.name, optionLabel: [v.color, v.size].filter(Boolean).join(" / ") })) };
}

export function createCartGiftSelectionService(client: PrismaClient, store: CookieReader, { shopId, env = process.env }: { shopId: number; env?: Readonly<Record<string, string | undefined>> }) {
  async function withCart<T>(now: Date, work: (tx: Prisma.TransactionClient, cartId: string) => Promise<T>) {
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
    try {
      return await client.$transaction(async (tx) => {
        const carts = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Cart" WHERE "id" = ${cartId} AND "userId" IS NULL AND "expiresAt" > ${now} FOR UPDATE`;
        if (carts.length !== 1) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
        // Same rows Admin revises: no accepted choice can race a rule/revision edit.
        const campaigns = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GiftQuantityCampaign"
          WHERE ("isEnabled" = true AND ("startsAt" IS NULL OR "startsAt" <= ${now}) AND ("endsAt" IS NULL OR "endsAt" > ${now}))
            OR "id" IN (SELECT "campaignId" FROM "CartGiftSelection" WHERE "cartId" = ${cartId})
          ORDER BY "id" LIMIT 151 FOR SHARE`;
        if (campaigns.length > 150) throw new Error("Campaign bound exceeded");
        return work(tx, cartId);
      });
    } catch {
      return { ok: false, reason: "LOOKUP_FAILED" } as const;
    }
  }

  async function get(now = new Date()) {
    if (!isGiftQuantityPromotionsEnabled(env)) return { enabled: false } as const;
    return withCart(now, async (tx, cartId) => ({ ok: true, state: await readState(tx, cartId, shopId, now, env) } as const));
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
      const state = await readState(tx, cartId, shopId, now, env);
      if (state.quote.lines.some((line) => !line.available)) return { ok: false, reason: "SELECTION_INVALID" } as const;
      const selection: GiftSelectionLine[] = [...state.selections.filter((row) => row.campaignId !== choice.campaignId || row.variantId !== choice.variantId), choice];
      const validation = validateGiftSelections({ campaigns: state.campaigns, entitlements: state.entitlements, selection });
      if (!validation.ok) return { ok: false, reason: "SELECTION_INVALID" } as const;
      const result = await setCartGiftSelection(tx, { cartId, ...choice });
      return result.ok ? { ok: true } as const : { ok: false, reason: "SELECTION_INVALID" } as const;
    });
  }
  return { get, set };
}
