/** Checkout-only +1 recommendations. Canonical cart, entitlement, shipping and COD quote authority. */
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { readAdvisoryHeldQuantities } from "./capacity-advisory.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { readCartGiftState, type CartGiftState } from "./cart-gift-selection.ts";
import { resolveBenefitCheckoutQuote } from "./benefit-checkout-quote.ts";
import { buildRenderedCheckoutQuoteFacts } from "./checkout-quote.ts";
import { CATALOG_SYNC_LOCK_NAMESPACE } from "./catalog-sync-lock.ts";
import { expandScopeCategoryKeys } from "./gift-quantity-scope.ts";
import { classifyCompositeComponentSku } from "./storefront-projection.ts";
import { classifyCompositeSubSetShape, isThreePieceComboShape } from "./composite-subset-authority.ts";
import { parseTrustedProductImageUrl } from "./product-media.ts";
import { buildCartGiftPickerModel, type CartGiftPickerModel } from "../routes/cart-gift-model.ts";
import { compareUpsellCandidates, findUpsellOpportunities, isPromotionUpsellEnabled, preservesUpsellBenefits, unlocksUpsellOpportunity, type UpsellOpportunity } from "./promotion-upsell-policy.ts";
import { isUpsellProofCurrent, issueUpsellQuoteProof, parseUpsellIntent, upsellPaidCartKey, upsellProofContext, verifiesUpsellQuote, type UpsellIntent, type UpsellQuote } from "./promotion-upsell-proof.ts";

// Local representative-fixture measurements and limitations are recorded in the implementation evidence.
export const UPSELL_MAX_PRODUCTS = 10;
export const UPSELL_MAX_VARIANTS_PER_PRODUCT = 3;
export const UPSELL_MAX_QUOTES = 20;
export const UPSELL_READ_TIMEOUT_MS = 2_000;
const UPSELL_WRITE_TIMEOUT_MS = 5_000;
type Env = Readonly<Record<string, string | undefined>>;
class UpsellQuoteUnavailable extends Error {}
type Snapshot = { state: CartGiftState; quote: UpsellQuote; totalVnd: number };
export type UpsellVariantView = Readonly<{ variantId: string; label: string; priceVnd: number; deltaVnd: number; intent: UpsellIntent }>;
export type CheckoutUpsellModel = Readonly<{
  paidCartKey: string;
  giftPicker: CartGiftPickerModel;
  offer: null | Readonly<{ campaignId: string; name: string; products: readonly Readonly<{ productId: string; name: string; imageUrl: string | null; variants: readonly UpsellVariantView[] }>[] }>;
}>;
type Metric = Readonly<{ event: "recommendation" | "add"; outcome: "offered" | "empty" | "failed" | "added" | "quote_changed" | "timed_out"; durationMs: number }>;
export function recordUpsellMetric(metric: Metric) {
  // Fixed enums + bounded duration only. Never log exceptions, identifiers, input, cookies or tokens.
  console.info("promotion_upsell", { event: metric.event, outcome: metric.outcome, durationMs: Math.min(60_000, Math.max(0, Math.round(metric.durationMs))) });
}

async function snapshot(tx: Prisma.TransactionClient, cartId: string, shopId: number, now: Date, env: Env, items?: CartGiftState["items"]): Promise<Snapshot> {
  const state = await readCartGiftState(tx, cartId, shopId, now, env, items);
  if (!state.validation.ok || state.quote.lines.length === 0 || state.quote.lines.some((line) => !line.available)) throw new UpsellQuoteUnavailable("Quote unavailable");
  const resolution = await resolveBenefitCheckoutQuote({ tx, cartId, shopId, now, env, giftState: state });
  if (resolution.kind === "BENEFIT") return { state, quote: { kind: "BENEFIT", facts: resolution.facts }, totalVnd: resolution.facts.totalVnd };
  if (resolution.kind !== "LEGACY") throw new UpsellQuoteUnavailable("Quote unavailable");
  const facts = buildRenderedCheckoutQuoteFacts(state.quote.lines);
  if (!facts) throw new UpsellQuoteUnavailable("Quote unavailable");
  return { state, quote: { kind: "LEGACY", facts }, totalVnd: facts.totalVnd };
}

async function discover(tx: Prisma.TransactionClient, state: CartGiftState, opportunities: readonly UpsellOpportunity[], shopId: number) {
  const ids = new Set(opportunities.map((o) => o.campaignId));
  const scopes = state.campaignEntries.filter((e) => ids.has(e.campaign.id)).map(({ campaign: c, scope }) => ({
    campaignId: c.id, mode: scope.mode, frozen: c.frozenAt !== null && c.frozenCampaignRevision !== null,
    includes: scope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : scope.includeProductIds,
    excludes: scope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : scope.excludeProductIds,
    keys: scope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : [...expandScopeCategoryKeys(scope.categoryKeys)],
  }));
  const paidIds = [...new Set(state.paidVariants.map((v) => v.productId))];
  // One bounded lateral lookup per near campaign, batched in one statement. Round-robin slots
  // allocate the combined pool across campaigns before quote ranking (which never uses priority).
  // Each lateral subquery stops at the product cap; the intermediate pool is <= 50 × cap rows.
  const pool = await tx.$queryRaw<{ id: string }[]>`
    WITH pool AS (
      SELECT s."campaignId", p."id", row_number() OVER (PARTITION BY s."campaignId" ORDER BY p."id") AS slot
      FROM jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb)
        AS s("campaignId" text, mode text, frozen boolean, includes jsonb, excludes jsonb, keys jsonb)
      CROSS JOIN LATERAL (
        SELECT p."id" FROM "ProductMirror" p
        WHERE p."pancakeShopId" = ${shopId} AND p."isActive" AND p."isPresent"
          AND NOT (p."id" = ANY(${paidIds}::text[]))
          AND EXISTS (SELECT 1 FROM "VariantMirror" v WHERE v."productId" = p."id" AND v."isActive" AND v."isPresent")
          AND (
            s.mode = 'GLOBAL_ALL_PAID_LINES'
            OR (s.mode = 'FIXED_PRODUCT_SET' AND s.frozen AND EXISTS (
              SELECT 1 FROM "GiftQuantityFrozenProduct" f WHERE f."campaignId" = s."campaignId" AND f."productId" = p."id"))
            OR (s.mode = 'DYNAMIC_CATEGORY'
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.excludes) e WHERE e = p."id")
              AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.includes) i WHERE i = p."id")
                OR EXISTS (SELECT 1 FROM "ProductCategoryMembership" m WHERE m."productId" = p."id"
                  AND m."categoryKey" IN (SELECT jsonb_array_elements_text(s.keys)))))
          )
        ORDER BY p."id" LIMIT ${UPSELL_MAX_PRODUCTS}
      ) p
    ) SELECT "id" FROM pool GROUP BY "id" ORDER BY min(slot), min("campaignId"), "id" LIMIT ${UPSELL_MAX_PRODUCTS}`;
  return tx.productMirror.findMany({
    where: { id: { in: pool.map((p) => p.id) } }, orderBy: { id: "asc" },
    select: { id: true, name: true, primaryImageUrl: true,
      variants: { where: { isActive: true, isPresent: true }, orderBy: { id: "asc" }, take: UPSELL_MAX_VARIANTS_PER_PRODUCT, select: { id: true, color: true, size: true, sku: true, pancakeDisplayId: true,
        compositeComponents: { select: { componentVariantId: true, quantity: true, componentVariant: { select: { sku: true, pancakeDisplayId: true } } } } } } },
  });
}

/** Reuse the PDP's kind vocabulary so equal color/size options still distinguish a set from a piece. */
export function upsellVariantLabel(variant: { color: string | null; size: string | null; sku: string | null; pancakeDisplayId: string | null; compositeComponents: readonly { componentVariantId: string; quantity: number; componentVariant: { sku: string | null; pancakeDisplayId: string | null } }[] }): string {
  const pieces = variant.compositeComponents.map((edge) => ({ ...edge, roleSku: edge.componentVariant.sku ?? edge.componentVariant.pancakeDisplayId }));
  const kind = pieces.length ? classifyCompositeSubSetShape(pieces) ?? (isThreePieceComboShape(pieces) ? "FULL SET" : "Bộ sản phẩm") : classifyCompositeComponentSku(variant.sku ?? variant.pancakeDisplayId);
  return [kind, variant.color, variant.size].filter(Boolean).join(" / ") || "Phiên bản tiêu chuẩn";
}

/** The snapshot is never written to get a quote. READY + whole-cart/gift preservation are checked here and again at commit. */
async function verifyCandidate(tx: Prisma.TransactionClient, before: Snapshot, opportunity: UpsellOpportunity | undefined, variantId: string, cartId: string, shopId: number, now: Date, env: Env) {
  const variant = await tx.variantMirror.findFirst({ where: { id: variantId, isActive: true, isPresent: true, product: { pancakeShopId: shopId, isActive: true, isPresent: true } }, select: { productId: true } });
  if (!variant || before.state.paidVariants.some((v) => v.productId === variant.productId) || before.state.items.length >= ANONYMOUS_CART_MAX_DISTINCT_ITEMS) return null;
  let after: Snapshot;
  try { after = await snapshot(tx, cartId, shopId, now, env, [...before.state.items, { variantId, quantity: 1 }]); }
  catch (error) { if (error instanceof UpsellQuoteUnavailable) return null; throw error; }
  const line = after.state.quote.lines.find((line) => line.variantId === variantId);
  if (!line?.available || line.isPreorderSale || !(opportunity ? unlocksUpsellOpportunity(before.state, after.state, opportunity) : preservesUpsellBenefits(before.state, after.state))) return null;
  // READY is resource-based: two different composites may consume the same component.
  // Checking each projected line independently cannot prove the added unit fits the whole cart.
  const affected = [...after.state.paidDemand].filter(([id, units]) => units > (before.state.paidDemand.get(id) ?? 0)).map(([id]) => id);
  const resources = await tx.variantMirror.findMany({ where: { id: { in: affected } }, select: { id: true, warehouseStocks: { select: { quantity: true } } } });
  const held = await readAdvisoryHeldQuantities(tx, affected);
  if (resources.length !== affected.length || resources.some((resource) => resource.warehouseStocks.reduce((n, row) => n + row.quantity, 0) - (held.get(resource.id) ?? 0) < after.state.paidDemand.get(resource.id)!)) return null;
  const benefits = after.state.quote.benefits;
  if (!benefits.enabled || !benefits.ok) return null;
  const priceVnd = benefits.groups.filter((g) => g.lineKey === variantId).reduce((sum, g) => sum + g.lineTotalVnd, 0);
  return { after, productId: variant.productId, priceVnd, deltaVnd: after.totalVnd - before.totalVnd };
}

export function createPromotionUpsellService(client: PrismaClient, store: { get(name: string): { value: string } | undefined }, { shopId, secret, env = process.env, metric = recordUpsellMetric }: { shopId: number; secret: string; env?: Env; metric?: (metric: Metric) => void }) {
  const report = (value: Metric) => { try { metric(value); } catch { /* observability cannot block checkout */ } };
  async function get(checkoutProof: string, now = new Date()): Promise<CheckoutUpsellModel | null> {
    if (!isPromotionUpsellEnabled(shopId, env)) return null;
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return null;
    const started = Date.now();
    try {
      const model = await client.$transaction(async (tx): Promise<CheckoutUpsellModel | null> => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1800ms'`;
        const cart = await tx.cart.findFirst({ where: { id: cartId, userId: null, expiresAt: { gt: now } }, select: { paidRevision: true } });
        if (!cart) return null;
        const before = await snapshot(tx, cartId, shopId, now, env);
        if (!verifiesUpsellQuote(before.quote, checkoutProof, cartId, secret)) return null;
        const opportunities = findUpsellOpportunities(before.state);
        const model: CheckoutUpsellModel = { paidCartKey: upsellPaidCartKey(cartId, cart.paidRevision, secret), giftPicker: buildCartGiftPickerModel(before.state), offer: null };
        if (!opportunities.length) return model;
        const products = await discover(tx, before.state, opportunities, shopId);
        const verified: { campaignId: string; productId: string; variantId: string; deltaVnd: number; view: UpsellVariantView }[] = [];
        let quotes = 0;
        // Round-robin variants by product: one product with many sizes cannot consume the whole quote budget.
        for (let option = 0; option < UPSELL_MAX_VARIANTS_PER_PRODUCT; option++) for (const p of products) {
          const v = p.variants[option];
          if (!v || quotes >= UPSELL_MAX_QUOTES) continue;
          if (Date.now() - started >= UPSELL_READ_TIMEOUT_MS) throw new Error("Recommendation deadline");
          quotes++;
          // One hypothetical quote covers every near campaign. No campaign × variant quote explosion.
          const result = await verifyCandidate(tx, before, undefined, v.id, cartId, shopId, now, env);
          if (!result) continue;
          const { after, priceVnd, deltaVnd } = result;
          for (const opportunity of opportunities) {
            if (!unlocksUpsellOpportunity(before.state, after.state, opportunity)) continue;
            const intent = { campaignId: opportunity.campaignId, variantId: v.id, issuedAt: now.getTime() };
            const proof = issueUpsellQuoteProof(before.quote, upsellProofContext(cartId, cart.paidRevision, opportunity.revision, intent, after.quote), secret);
            if (!proof) continue;
            verified.push({ campaignId: opportunity.campaignId, productId: p.id, variantId: v.id, deltaVnd,
              view: { variantId: v.id, label: upsellVariantLabel(v), priceVnd, deltaVnd, intent: { ...intent, proof } } });
          }
        }
        verified.sort(compareUpsellCandidates);
        const winner = verified[0];
        if (!winner) return model;
        const productIds = [...new Set(verified.filter((v) => v.campaignId === winner.campaignId).map((v) => v.productId))].slice(0, 5);
        return { ...model, offer: { campaignId: winner.campaignId, name: before.state.campaignEntries.find((e) => e.campaign.id === winner.campaignId)!.campaign.name,
          products: productIds.map((productId) => {
            const p = products.find((p) => p.id === productId)!;
            return { productId, name: p.name, imageUrl: parseTrustedProductImageUrl(p.primaryImageUrl), variants: verified.filter((v) => v.campaignId === winner.campaignId && v.productId === productId).map((v) => v.view) };
          }) } };
      }, { isolationLevel: "RepeatableRead", maxWait: 200, timeout: UPSELL_READ_TIMEOUT_MS });
      report({ event: "recommendation", outcome: model?.offer ? "offered" : "empty", durationMs: Date.now() - started });
      return model;
    } catch {
      report({ event: "recommendation", outcome: Date.now() - started >= 1800 ? "timed_out" : "failed", durationMs: Date.now() - started });
      return null;
    }
  }

  async function requote(input: unknown, now = new Date()) {
    const intent = parseUpsellIntent(input);
    if (!intent || !isPromotionUpsellEnabled(shopId, env) || !isUpsellProofCurrent(intent.issuedAt, now)) return { ok: false } as const;
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false } as const;
    try {
      return await client.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1800ms'`;
        const cart = await tx.cart.findFirst({ where: { id: cartId, userId: null, expiresAt: { gt: now } }, select: { paidRevision: true } });
        if (!cart) return { ok: false } as const;
        const before = await snapshot(tx, cartId, shopId, now, env);
        const opportunity = findUpsellOpportunities(before.state).find((o) => o.campaignId === intent.campaignId);
        if (!opportunity) return { ok: false } as const;
        const candidate = await verifyCandidate(tx, before, opportunity, intent.variantId, cartId, shopId, now, env);
        if (!candidate || !verifiesUpsellQuote(before.quote, intent.proof, upsellProofContext(cartId, cart.paidRevision, opportunity.revision, intent, candidate.after.quote), secret)) return { ok: false } as const;
        const renewed = { campaignId: intent.campaignId, variantId: intent.variantId, issuedAt: now.getTime() };
        const proof = issueUpsellQuoteProof(before.quote, upsellProofContext(cartId, cart.paidRevision, opportunity.revision, renewed, candidate.after.quote), secret);
        return proof ? { ok: true, variant: { variantId: intent.variantId, priceVnd: candidate.priceVnd, deltaVnd: candidate.deltaVnd, intent: { ...renewed, proof } } } as const : { ok: false } as const;
      }, { isolationLevel: "RepeatableRead", maxWait: 200, timeout: UPSELL_READ_TIMEOUT_MS });
    } catch { return { ok: false } as const; }
  }

  async function add(input: unknown, now = new Date()) {
    const intent = parseUpsellIntent(input);
    if (!intent || !isPromotionUpsellEnabled(shopId, env)) return { ok: false, reason: "OFFER_UNAVAILABLE" } as const;
    const started = Date.now();
    if (!isUpsellProofCurrent(intent.issuedAt, now)) {
      report({ event: "add", outcome: "quote_changed", durationMs: 0 });
      return { ok: false, reason: "OFFER_UNAVAILABLE" } as const;
    }
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false, reason: "OFFER_UNAVAILABLE" } as const;
    try {
      const result = await client.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
        const carts = await tx.$queryRaw<{ paidRevision: bigint }[]>`SELECT "paidRevision" FROM "Cart" WHERE "id" = ${cartId} AND "userId" IS NULL AND "expiresAt" > ${now} FOR UPDATE`;
        if (carts.length !== 1) return { ok: false, reason: "OFFER_UNAVAILABLE" } as const;
        // Global promotion lock covers inactive→active phantoms, legacy consents and all campaign edits.
        const revisions = await tx.$queryRaw<{ revision: bigint }[]>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = 'current' FOR SHARE`;
        if (revisions.length !== 1) throw new Error("Missing promotion revision");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${CATALOG_SYNC_LOCK_NAMESPACE}, ${shopId})`;
        // Same variant resource rows as reserveOrderCapacity, including gift resources. Catalog sync
        // holds the shop lock above; reservations hold these rows. Neither stock nor holds can race.
        const before = await snapshot(tx, cartId, shopId, now, env);
        const opportunity = findUpsellOpportunities(before.state).find((o) => o.campaignId === intent.campaignId);
        if (!opportunity) return { ok: false, reason: "QUOTE_CHANGED" } as const;
        const optionIds = before.state.campaigns.flatMap((c) => c.options.map((o) => o.variantId));
        const resourceIds = [...new Set([...before.state.items.map((i) => i.variantId), intent.variantId, ...optionIds])];
        await tx.$queryRawUnsafe('SELECT "id" FROM "VariantMirror" WHERE "id" = ANY($1::text[]) OR "id" IN (SELECT "componentVariantId" FROM "CompositeComponentMirror" WHERE "parentVariantId" = ANY($1::text[])) ORDER BY "id" FOR SHARE', resourceIds);
        // Re-read after resource locks: a reservation may have committed while we waited.
        const lockedBefore = await snapshot(tx, cartId, shopId, now, env);
        const candidate = await verifyCandidate(tx, lockedBefore, opportunity, intent.variantId, cartId, shopId, now, env);
        if (!candidate || !verifiesUpsellQuote(lockedBefore.quote, intent.proof, upsellProofContext(cartId, carts[0]!.paidRevision, opportunity.revision, intent, candidate.after.quote), secret)) return { ok: false, reason: "QUOTE_CHANGED" } as const;
        await tx.cartItem.create({ data: { cartId, variantId: intent.variantId, quantity: 1 } });
        const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartId }, select: { paidRevision: true } });
        const newGiftCampaignIds = candidate.after.state.entitlements.filter((e) => e.entitled > (lockedBefore.state.entitlements.find((b) => b.campaignId === e.campaignId)?.entitled ?? 0)).map((e) => e.campaignId);
        return { ok: true, paidCartKey: upsellPaidCartKey(cartId, cart.paidRevision, secret), newGiftCampaignIds } as const;
      }, { maxWait: 300, timeout: UPSELL_WRITE_TIMEOUT_MS });
      report({ event: "add", outcome: result.ok ? "added" : "quote_changed", durationMs: Date.now() - started });
      return result;
    } catch {
      report({ event: "add", outcome: "failed", durationMs: Date.now() - started });
      return { ok: false, reason: "OFFER_UNAVAILABLE" } as const;
    }
  }
  return { get, requote, add };
}
