import { readGuestShippingPolicy } from "./guest-shipping-policy.ts";
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
import { createUpsellBrowseCache, type UpsellBrowseCache } from "./promotion-upsell-browse-cache.ts";
import { nextCampaignBoundaryMs, readBrowseKeyInputs } from "./promotion-upsell-browse-key.ts";
import { memoizeTransactionReads } from "./tx-read-memo.ts";
import { buildCartGiftPickerModel, type CartGiftPickerModel } from "../routes/cart-gift-model.ts";
import { compareUpsellCandidates, findUpsellOpportunities, isPromotionUpsellEnabled, preservesUpsellBenefits, unlocksUpsellOpportunity, type UpsellOpportunity } from "./promotion-upsell-policy.ts";
import { isUpsellProofCurrent, issueUpsellQuoteProof, parseUpsellIntent, upsellPaidCartKey, upsellProofContext, verifiesUpsellQuote, type UpsellIntent, type UpsellQuote } from "./promotion-upsell-proof.ts";

// Local representative-fixture measurements and limitations are recorded in the implementation evidence.
export const UPSELL_MAX_PRODUCTS = 10;
export const UPSELL_MAX_VARIANTS_PER_PRODUCT = 3;
export const UPSELL_MAX_QUOTES = 20;
export const UPSELL_BANNER_MAX_QUOTES = 6;
export const UPSELL_READ_TIMEOUT_MS = 2_000;
// The browse page is optional and off the payment path: it stops early with what it verified instead
// of spending the whole read budget, and returns a partial list rather than nothing at the soft deadline.
export const UPSELL_BROWSE_MAX_QUOTES = 8;
export const UPSELL_BROWSE_TARGET_PRODUCTS = 3;
export const UPSELL_BROWSE_SOFT_DEADLINE_MS = 1_300;
const UPSELL_WRITE_TIMEOUT_MS = 5_000;
type Env = Readonly<Record<string, string | undefined>>;
class UpsellQuoteUnavailable extends Error {}
type BrowseStatus = { truncated: boolean; retryable: boolean; validUntil: number | null; txKey: string | null };
/**
 * `readCartGiftState` refuses a cart it cannot price or evaluate with plain Errors. These three are
 * deterministic for the cart it was given (retrying cannot change them), so `snapshot` re-throws them as
 * `UpsellQuoteUnavailable`: for the paid cart that means "no valid quote" (empty, not retryable); for one
 * hypothetical +1 cart it means "skip this candidate" in `verifyCandidate`, never "discard the others".
 */
const DETERMINISTIC_QUOTE_ERRORS: ReadonlySet<string> = new Set(["Quote unavailable", "Invalid gift configuration", "Options bound exceeded"]);
const isDeterministicQuoteFailure = (error: unknown) => error instanceof UpsellQuoteUnavailable;
/**
 * `resolveBenefitCheckoutQuote` reports any exception from its data reads (state, vouchers, shipping) as `UNAVAILABLE`.
 * A RangeError/TypeError there is the cart's own shape (too many lines, unknown product) and cannot change on retry;
 * anything else (a dropped connection, a statement timeout) is infrastructure and must stay retryable.
 */
const isDeterministicReadFailure = (error: unknown) => error instanceof RangeError || error instanceof TypeError ||
  (error instanceof Error && DETERMINISTIC_QUOTE_ERRORS.has(error.message));
// Key = paid cart (HMAC over cart + paid revision) + promotion pricing revision (any effective campaign edit,
// enable or disable) + the cart's gift choices (they do not advance the paid revision) + campaign. Entries
// also expire at the next campaign start/end, which advances no revision (see promotion-upsell-browse-key.ts).
const browseCacheKey = (paidCartKey: string, inputs: { promotionRevision: bigint; selectionDigest: string }, campaignId: string) =>
  `${paidCartKey}:${inputs.promotionRevision}:${inputs.selectionDigest}:${campaignId}`;
type Snapshot = { state: CartGiftState; quote: UpsellQuote; totalVnd: number };
export type UpsellVariantView = Readonly<{ variantId: string; label: string; priceVnd: number; deltaVnd: number; intent: UpsellIntent }>;
export type CheckoutUpsellBanner = Readonly<{ paidCartKey: string; offerName: string | null; campaignId: string | null }>;
/** Read-only, cart-scoped candidates, rechecked at browse time. No cart ids, prices or replayable intents. */
export type CheckoutUpsellBrowse = Readonly<{
  offerName: string;
  products: readonly Readonly<{ slug: string; name: string; imageUrl: string | null; options: readonly string[] }>[];
}>;
/** `retryable` marks a timeout or failure, so the page can say "slow, try again" instead of "offer changed". */
export type CheckoutUpsellBrowseResult = Readonly<{ offer: CheckoutUpsellBrowse | null; retryable: boolean }>;
export type CheckoutUpsellModel = Readonly<{
  paidCartKey: string;
  // UI-only recovery marker for one committed CartItem insert; never authorizes a mutation.
  nextPaidCartKey: string;
  giftPicker: CartGiftPickerModel;
  offer: null | Readonly<{ campaignId: string; name: string; products: readonly Readonly<{ productId: string; name: string; imageUrl: string | null; variants: readonly UpsellVariantView[] }>[] }>;
}>;
type Metric = Readonly<{ event: "recommendation" | "browse" | "add"; outcome: "offered" | "empty" | "failed" | "added" | "quote_changed" | "timed_out" | "partial" | "cached"; durationMs: number; quoteAttempts?: number }>;
export function recordUpsellMetric(metric: Metric) {
  // Fixed enums + bounded duration only. Never log exceptions, identifiers, input, cookies or tokens.
  console.info("promotion_upsell", { event: metric.event, outcome: metric.outcome, durationMs: Math.min(60_000, Math.max(0, Math.round(metric.durationMs))), ...(metric.quoteAttempts === undefined ? {} : { quoteAttempts: Math.min(UPSELL_MAX_QUOTES, Math.max(0, Math.round(metric.quoteAttempts))) }) });
}

async function snapshot(tx: Prisma.TransactionClient, cartId: string, shopId: number, now: Date, env: Env, items?: CartGiftState["items"]): Promise<Snapshot> {
  let state: Awaited<ReturnType<typeof readCartGiftState>>;
  try { state = await readCartGiftState(tx, cartId, shopId, now, env, items); }
  catch (error) { throw error instanceof Error && DETERMINISTIC_QUOTE_ERRORS.has(error.message) ? new UpsellQuoteUnavailable(error.message) : error; }
  if (!state.validation.ok || state.quote.lines.length === 0 || state.quote.lines.some((line) => !line.available)) throw new UpsellQuoteUnavailable("Quote unavailable");
  let readFailure: unknown;
  const resolution = await resolveBenefitCheckoutQuote({ tx, cartId, shopId, now, env, giftState: state, onError: (error) => { readFailure ??= error; } });
  if (resolution.kind === "BENEFIT") return { state, quote: { kind: "BENEFIT", facts: resolution.facts }, totalVnd: resolution.facts.totalVnd };
  // A transient read failure is surfaced as itself, so the browse says "try again" and the log says failed.
  if (resolution.kind !== "LEGACY") throw readFailure !== undefined && !isDeterministicReadFailure(readFailure) ? readFailure : new UpsellQuoteUnavailable("Quote unavailable");
  const facts = buildRenderedCheckoutQuoteFacts(state.quote.lines, { shippingQuote: resolution.shippingQuote, shippingPolicy: readGuestShippingPolicy(env) });
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
    select: { id: true, slug: true, name: true, primaryImageUrl: true,
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

// One browse cache per Node process, shared by the page and route-handler chunks (like the read gate).
type ProcessBrowseCache = typeof globalThis & { __laUpsellBrowseCacheV1?: UpsellBrowseCache<CheckoutUpsellBrowse> };
const processBrowse = globalThis as ProcessBrowseCache;
export const processUpsellBrowseCache = processBrowse.__laUpsellBrowseCacheV1 ??= createUpsellBrowseCache<CheckoutUpsellBrowse>();

export function createPromotionUpsellService(client: PrismaClient, store: { get(name: string): { value: string } | undefined }, { shopId, secret, env = process.env, metric = recordUpsellMetric, browseCache = processUpsellBrowseCache, clock = Date.now }: { shopId: number; secret: string; env?: Env; metric?: (metric: Metric) => void; browseCache?: UpsellBrowseCache<CheckoutUpsellBrowse> | null; clock?: () => number }) {
  const report = (value: Metric) => { try { metric(value); } catch { /* observability cannot block checkout */ } };
  function recommend(checkoutProof: string, now: Date, maxQuotes: number, mode: "full"): Promise<CheckoutUpsellModel | null>;
  function recommend(checkoutProof: string, now: Date, maxQuotes: number, mode: "banner"): Promise<CheckoutUpsellBanner | null>;
  function recommend(checkoutProof: null, now: Date, maxQuotes: number, mode: "browse", campaignId: string, status: BrowseStatus): Promise<CheckoutUpsellBrowse | null>;
  async function recommend(
    checkoutProof: string | null, now: Date, maxQuotes: number, mode: "full" | "banner" | "browse", campaignId?: string, status?: BrowseStatus,
  ): Promise<CheckoutUpsellModel | CheckoutUpsellBanner | CheckoutUpsellBrowse | null> {
    if (!isPromotionUpsellEnabled(shopId, env)) return null;
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return null;
    const started = clock();
    const event = mode === "browse" ? "browse" : "recommendation";
    let quoteAttempts = 0;
    let truncated = false;
    let deadlineHit = false;
    // The checkout banner already verified real products for this cart; hand them to the browse page.
    const seed: { key?: string; value?: CheckoutUpsellBrowse; validUntil?: number | null } = {};
    let validUntil: number | null = null;
    try {
      const model = await client.$transaction(async (rawTx): Promise<CheckoutUpsellModel | CheckoutUpsellBanner | CheckoutUpsellBrowse | null> => {
        await rawTx.$executeRaw`SET LOCAL statement_timeout = '1800ms'`;
        // Read-only repeatable-read snapshot: identical campaign/policy reads repeat per candidate for nothing.
        const tx = memoizeTransactionReads(rawTx);
        const cart = await tx.cart.findFirst({ where: { id: cartId, userId: null, expiresAt: { gt: now } }, select: { paidRevision: true } });
        if (!cart) return null;
        const before = await snapshot(tx, cartId, shopId, now, env);
        // Browsing is read-only and bound to this shopper's cart. Checkout API reads still require proof.
        if (mode !== "browse" && (checkoutProof === null || !verifiesUpsellQuote(before.quote, checkoutProof, cartId, secret))) return null;
        const opportunities = findUpsellOpportunities(before.state)
          .filter((opportunity) => mode !== "browse" || opportunity.campaignId === campaignId);
        const paidCartKey = upsellPaidCartKey(cartId, cart.paidRevision, secret);
        // The key the cache would use, read in THIS snapshot. `getBrowse` looked its key up before this transaction began;
        // if gift choices (which can return to an earlier value) or anything else moved in between, the two differ.
        if (mode === "browse" && status) status.txKey = browseCacheKey(paidCartKey, await readBrowseKeyInputs(tx, cartId), campaignId!);
        const fullModel = (offer: CheckoutUpsellModel["offer"]): CheckoutUpsellModel => ({
          paidCartKey,
          nextPaidCartKey: upsellPaidCartKey(cartId, cart.paidRevision + BigInt(1), secret),
          giftPicker: buildCartGiftPickerModel(before.state),
          offer,
        });
        const banner = (offerName: string | null, id: string | null): CheckoutUpsellBanner => ({ paidCartKey, offerName, campaignId: id });
        if (!opportunities.length) return mode === "browse" ? null : mode === "banner" ? banner(null, null) : fullModel(null);

        const products = await discover(tx, before.state, opportunities, shopId);
        const verified: {
          campaignId: string; productId: string; variantId: string; deltaVnd: number;
          view?: UpsellVariantView;
          label?: string;
        }[] = [];
        // Distribute the bounded quote budget across products before trying another size.
        search: for (let option = 0; option < UPSELL_MAX_VARIANTS_PER_PRODUCT; option++) for (const p of products) {
          const v = p.variants[option];
          if (!v || quoteAttempts >= maxQuotes) continue;
          if (mode === "browse" && new Set(verified.map((c) => c.productId)).size >= UPSELL_BROWSE_TARGET_PRODUCTS) break search;
          if (clock() - started >= (mode === "browse" ? UPSELL_BROWSE_SOFT_DEADLINE_MS : UPSELL_READ_TIMEOUT_MS)) {
            if (mode !== "browse") { deadlineHit = true; throw new Error("Recommendation deadline"); }
            truncated = true;
            break search;
          }
          quoteAttempts++;
          // Both modes run the canonical quote and READY/benefit checks.
          const result = await verifyCandidate(tx, before, undefined, v.id, cartId, shopId, now, env);
          if (!result) continue;
          const { after, priceVnd, deltaVnd } = result;
          for (const opportunity of opportunities) {
            if (!unlocksUpsellOpportunity(before.state, after.state, opportunity)) continue;
            const choice = { campaignId: opportunity.campaignId, productId: p.id, variantId: v.id, deltaVnd };
            if (mode === "banner") {
              // A browsing link cannot replay an add; do not sign/store unused variant intents.
              verified.push({ ...choice, label: upsellVariantLabel(v) });
              continue;
            }
            if (mode === "browse") {
              verified.push({ ...choice, label: upsellVariantLabel(v) });
              continue;
            }
            const intent = { campaignId: opportunity.campaignId, variantId: v.id, issuedAt: now.getTime() };
            const proof = issueUpsellQuoteProof(before.quote, upsellProofContext(cartId, cart.paidRevision, opportunity.revision, intent, after.quote), secret);
            if (!proof) continue;
            verified.push({ ...choice,
              view: { variantId: v.id, label: upsellVariantLabel(v), priceVnd, deltaVnd, intent: { ...intent, proof } } });
          }
        }
        // Out of time with nothing verified is a timeout; with something verified it is a shorter list.
        if (truncated && !verified.length) { deadlineHit = true; throw new Error("Recommendation deadline"); }
        verified.sort(compareUpsellCandidates);
        const winner = verified[0];
        if (!winner) return mode === "browse" ? null : mode === "banner" ? banner(null, null) : fullModel(null);
        const name = before.state.campaignEntries.find((e) => e.campaign.id === winner.campaignId)!.campaign.name;
        if (mode !== "full") validUntil = await nextCampaignBoundaryMs(tx, now);
        const browseView = (): CheckoutUpsellBrowse => {
          const ids = [...new Set(verified.filter((v) => v.campaignId === winner.campaignId).map((v) => v.productId))]
            .slice(0, UPSELL_MAX_PRODUCTS);
          return {
            offerName: name,
            products: ids.map((productId) => {
              const product = products.find((p) => p.id === productId)!;
              return {
                slug: product.slug, name: product.name,
                imageUrl: parseTrustedProductImageUrl(product.primaryImageUrl),
                options: [...new Set(verified.filter((v) => v.campaignId === winner.campaignId && v.productId === productId).map((v) => v.label!))],
              };
            }),
          };
        };
        if (mode === "banner") {
          // Same snapshot as the quote, so the key inputs cannot be newer or older than the verified products.
          // The banner spends 6 quotes, browse up to 8 for 3 products: seed only a list that already meets the browse
          // target, so a short one is never pinned for the TTL when browse could find more (as for a partial run).
          const view = browseView();
          if (view.products.length >= UPSELL_BROWSE_TARGET_PRODUCTS) {
            seed.key = browseCacheKey(paidCartKey, await readBrowseKeyInputs(tx, cartId), winner.campaignId);
            seed.value = view; seed.validUntil = validUntil;
          }
          return banner(name, winner.campaignId);
        }
        if (mode === "browse") return browseView();

        const productIds = [...new Set(verified.filter((v) => v.campaignId === winner.campaignId).map((v) => v.productId))].slice(0, 5);
        return fullModel({ campaignId: winner.campaignId, name,
          products: productIds.map((productId) => {
            const p = products.find((p) => p.id === productId)!;
            return { productId, name: p.name, imageUrl: parseTrustedProductImageUrl(p.primaryImageUrl),
              variants: verified.filter((v) => v.campaignId === winner.campaignId && v.productId === productId).map((v) => v.view!) };
          }) });
      }, { isolationLevel: "RepeatableRead", maxWait: 200, timeout: UPSELL_READ_TIMEOUT_MS });
      const offered = model && ("offerName" in model ? model.offerName !== null : model.offer !== null);
      report({ event, outcome: offered ? (truncated ? "partial" : "offered") : "empty", durationMs: clock() - started, quoteAttempts });
      if (status) { status.truncated = truncated; status.validUntil = validUntil; }
      if (seed.key && seed.value && browseCache) browseCache.set(seed.key, seed.value, seed.validUntil);
      return model;
    } catch (error) {
      // A cart without a valid quote is an empty browse, not a failure to retry (retries cost rate limit).
      const deterministic = isDeterministicQuoteFailure(error);
      report({ event, outcome: deterministic && mode === "browse" ? "empty" : deadlineHit || clock() - started >= 1800 ? "timed_out" : "failed",
        durationMs: clock() - started, quoteAttempts });
      if (status) status.retryable = !deterministic;
      return null;
    }
  }

  async function get(checkoutProof: string, now = new Date()) {
    return recommend(checkoutProof, now, UPSELL_MAX_QUOTES, "full");
  }

  async function getBanner(checkoutProof: string, now = new Date()) {
    return recommend(checkoutProof, now, UPSELL_BANNER_MAX_QUOTES, "banner");
  }

  /**
   * Verified candidates for one active campaign in the current cart; never mints an add proof. A fresh
   * entry for the same paid cart (seeded by the checkout banner or an earlier visit) skips the quotes.
   */
  async function getBrowse(campaignId: string, now = new Date()): Promise<CheckoutUpsellBrowseResult> {
    const none = { offer: null, retryable: false } as const;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId)) return none;
    // `expectedKey` is the key the caller looked up before this transaction. The list is stored only if the quote's own
    // snapshot yields the same key; otherwise this request is still served the fresher list, but it is never cached under
    // a key (for example gift choice A) that it was not computed for (it was verified under B).
    const compute = async (expectedKey?: string) => {
      const status: BrowseStatus = { truncated: false, retryable: false, validUntil: null, txKey: null };
      const offer = await recommend(null, now, UPSELL_BROWSE_MAX_QUOTES, "browse", campaignId, status);
      // A partial or failed run must not pin a short list for the TTL; the next visit recomputes.
      const keyMatches = expectedKey === undefined || status.txKey === expectedKey;
      return { value: offer, store: !status.truncated && !status.retryable && keyMatches, failed: status.retryable, validUntil: status.validUntil };
    };
    if (!browseCache || !isPromotionUpsellEnabled(shopId, env)) { const r = await compute(); return { offer: r.value, retryable: r.failed }; }
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return none;
    const started = clock();
    try {
      const [cart, inputs] = await Promise.all([
        client.cart.findFirst({ where: { id: cartId, userId: null, expiresAt: { gt: now } }, select: { paidRevision: true } }),
        readBrowseKeyInputs(client, cartId),
      ]);
      if (!cart) return none;
      const key = browseCacheKey(upsellPaidCartKey(cartId, cart.paidRevision, secret), inputs, campaignId);
      const result = await browseCache.resolve(key, () => compute(key));
      if (result.cached) report({ event: "browse", outcome: "cached", durationMs: clock() - started, quoteAttempts: 0 });
      return { offer: result.value, retryable: result.failed };
    } catch {
      // Cart-key lookup or cache failure: still a browse request, so it must show up in the aggregate logs.
      report({ event: "browse", outcome: "failed", durationMs: clock() - started, quoteAttempts: 0 });
      return { offer: null, retryable: true };
    }
  }

  async function requote(input: unknown, now = new Date()) {
    const intent = parseUpsellIntent(input);
    if (!intent || !isPromotionUpsellEnabled(shopId, env) || !isUpsellProofCurrent(intent.issuedAt, now)) return { ok: false } as const;
    const cartId = readAnonymousCartCookie(store);
    if (!cartId) return { ok: false } as const;
    try {
      return await client.$transaction(async (rawTx) => {
        await rawTx.$executeRaw`SET LOCAL statement_timeout = '1800ms'`;
        const tx = memoizeTransactionReads(rawTx); // read-only snapshot, see recommend()
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
        // Publication actions can update only ProductMirror without taking the catalog guard.
        // Protect paid, candidate, gift and component products before the authoritative re-read.
        await tx.$queryRawUnsafe('SELECT "id" FROM "ProductMirror" WHERE "id" IN (SELECT "productId" FROM "VariantMirror" WHERE "id" = ANY($1::text[]) OR "id" IN (SELECT "componentVariantId" FROM "CompositeComponentMirror" WHERE "parentVariantId" = ANY($1::text[]))) ORDER BY "id" FOR SHARE', resourceIds);
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
  return { get, getBanner, getBrowse, requote, add };
}
