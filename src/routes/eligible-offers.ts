import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { readAnonymousCartCookie } from "@/commerce/anonymous-cart-cookie";
import { isTrustedUpsellBrowseRequest } from "@/commerce/checkout-upsell-http";
import { upsellReadGate } from "@/commerce/checkout-upsell-read-gate";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { createGuestCheckoutRateLimiter } from "@/commerce/guest-checkout-rate-limit";
import { createPromotionUpsellService, recordUpsellMetric, UPSELL_SCOPE_PAGE_SIZE, type UpsellScopeCursor } from "@/commerce/promotion-upsell";
import { isPromotionUpsellEnabled } from "@/commerce/promotion-upsell-policy";
import { listConfiguredStorefrontListingProductsByIds } from "@/commerce/storefront-catalog-runtime";
import { parseStorefrontListingPage, type StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "@/commerce/storefront-promotion-freshness";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { buildFlashSaleViewModel, type FlashSaleViewModel } from "./flash-sale-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * Personalized, read-only offer listing: every addable product in the scope of the offer the checkout banner named,
 * drawn as the storefront's own listing (same cards, prices, paging) and never as an authority over the cart.
 */
export type EligibleOffersRouteProps = Readonly<{ searchParams: Promise<StorefrontDiscoverySearchParams> }>;
export type EligibleOffersViewModel = Readonly<{
  campaignId: string | null;
  offerName: string | null;
  /** The scope page's product ids, drawn or not; only the continuation request reads it. */
  consumedProductIds?: readonly string[];
  /** The products ahead of a page opened at `?page=N`, so the listing can continue after them; `null` when too many. */
  precedingProductIds?: readonly string[] | null;
  listing: FlashSaleViewModel | null;
  limited: boolean;
  /** Set only after a timeout or failure, so the page can offer a retry instead of "offer changed". */
  retryHref: string | null;
}>;
const empty: EligibleOffersViewModel = { campaignId: null, offerName: null, listing: null, limited: false, retryHref: null };

const eligibleHref = (campaignId: string, page: number) =>
  `/offers/eligible?campaign=${encodeURIComponent(campaignId)}${page > 1 ? `&page=${page}` : ""}`;

type Loaded = Readonly<{ view: EligibleOffersViewModel; refreshAfterMs: number }>;
const fallback = (view: EligibleOffersViewModel): Loaded => ({ view, refreshAfterMs: MAX_STOREFRONT_PROMOTION_REFRESH_MS });

async function listForCart(
  campaignId: string,
  page: number,
  options?: { throwOnNotFound?: boolean; cursor?: UpsellScopeCursor },
): Promise<Loaded> {
  const throwOnNotFound = options?.throwOnNotFound ?? true;
  const cursor = options?.cursor;
  try {
    const store = await cookies();
    const cartId = readAnonymousCartCookie(store);
    // A missing/malformed cart never consumes the checkout banner's shared IP quota.
    if (!cartId) return fallback(empty);

    const auth = readAuthServerConfig();
    const requestHeaders = await headers();
    // SameSite=Lax alone does not stop cross-site top-level GET navigation.
    // Reject cross-origin and speculative fetches before acquiring a slot or touching the DB.
    if (!isTrustedUpsellBrowseRequest(requestHeaders, auth.baseURL)) return fallback(empty);
    const shopId = readPancakeShopId();
    if (!isPromotionUpsellEnabled(shopId)) return fallback(empty);

    const release = upsellReadGate.tryAcquire();
    if (!release) return fallback({ ...empty, campaignId, limited: true });
    let scope: Awaited<ReturnType<ReturnType<typeof createPromotionUpsellService>["getScope"]>>;
    const now = new Date();
    // The gate admits quote work only (shared with the checkout banner). It is released as soon as the scope is known,
    // so slow catalog hydration below can never hold both slots and make the banner's POST return nothing.
    try {
      const clientKey = deriveGuestCheckoutClientKey(requestHeaders, auth);
      const limiter = createGuestCheckoutRateLimiter(prisma);
      // A separate DB bucket bounds even forged, well-formed cookie IDs across app instances.
      // It cannot use up the POST banner's 20/minute budget. Page 2 onward has its own bucket (see the limiter), so
      // paging through a large scope neither trips this first-page limit nor spends the banner's budget.
      // A continuation always spends the page budget, never the first-page one, whatever its `page` says.
      const firstPage = page === 1 && !cursor;
      if (!(await (firstPage ? limiter.consumeUpsellBrowseClient({ clientKey }) : limiter.consumeUpsellPageClient({ clientKey })))) return fallback({ ...empty, campaignId, limited: true });
      const cart = await prisma.cart.findFirst({
        where: { id: cartId, userId: null, expiresAt: { gt: new Date() }, items: { some: {} } },
        select: { id: true },
      });
      if (!cart) return fallback(empty);
      // Only a confirmed, unexpired guest cart may spend the shared POST upsell budget (first page only).
      if (firstPage && !(await limiter.consumeUpsellClient({ clientKey }))) return fallback({ ...empty, campaignId, limited: true });
      scope = await createPromotionUpsellService(prisma, store, { shopId, secret: auth.secret }).getScope(campaignId, page, now, cursor);
    } finally {
      release();
    }
    const retryHref = scope.retryable ? eligibleHref(campaignId, page) : null;
    if (!scope.page) return fallback({ ...empty, campaignId, retryHref });
    // With a cursor the count is what is left once what the shopper has seen is excluded.
    const remaining = scope.page.totalCount;
    const totalPages = Math.ceil(remaining / UPSELL_SCOPE_PAGE_SIZE);
    // A page past the end is a URL that does not exist; page 1 of an empty scope is the empty state. A continuation that
    // has run out of products is simply the end of the list.
    if (!cursor && page > Math.max(totalPages, 1)) {
      if (throwOnNotFound) notFound();
      return fallback({ ...empty, campaignId, listing: null });
    }

    let catalog: Awaited<ReturnType<typeof listConfiguredStorefrontListingProductsByIds>>;
    // The scope is known; a failing catalog read is a hiccup to retry, not "the offer changed".
    // Its own metric (`hydrate`) so end-to-end latency is visible next to the quote-and-SQL `scope` event.
    const hydrating = Date.now();
    try { catalog = await listConfiguredStorefrontListingProductsByIds({ ids: scope.page.productIds, now }); }
    catch {
      recordUpsellMetric({ event: "hydrate", outcome: "failed", durationMs: Date.now() - hydrating });
      return fallback({ ...empty, campaignId, retryHref: eligibleHref(campaignId, page) });
    }
    recordUpsellMetric({ event: "hydrate", outcome: "offered", durationMs: Date.now() - hydrating });
    const listing = buildFlashSaleViewModel({
      basePath: "/offers/eligible",
      products: catalog.products,
      totalCount: remaining,
      totalPages,
      page: cursor ? 1 : page,
      pageSize: UPSELL_SCOPE_PAGE_SIZE,
      selectEventBySlug: new Map(),
      pricingRule: catalog.pricingRule,
    });
    return {
      view: {
        campaignId,
        offerName: scope.page.offerName,
        consumedProductIds: scope.page.productIds,
        precedingProductIds: scope.page.precedingProductIds,
        // The shared builder pages on `?page=`; this route also carries the campaign.
        listing: { ...listing,
          previousHref: page > 1 ? eligibleHref(campaignId, page - 1) : null,
          nextHref: page < totalPages ? eligibleHref(campaignId, page + 1) : null },
        limited: false,
        retryHref: null,
      },
      refreshAfterMs: catalog.refreshAfterMs,
    };
  } catch (error) {
    // Next signals notFound()/redirect by throwing; those must reach the framework.
    if (error instanceof Error && "digest" in error) throw error;
    // Optional recommendations always fail closed; checkout submit and quote remain independent.
    return fallback(empty);
  }
}

export type EligibleOffersNextPageResult = Readonly<{
  ok: boolean;
  cards: readonly Readonly<{ id: string; model: import("@/components/headless/build-product-card-model").ProductCardModel }>[];
  /** Every product the page covered, including any the catalog would not draw, so the next request skips them too. */
  consumedProductIds: readonly string[];
  totalCount: number;
  hasNext: boolean;
  limited?: boolean;
  error?: string | null;
}>;

const NEXT_PAGE_FAILED = { ok: false, cards: [], consumedProductIds: [], totalCount: 0, hasNext: false } as const;

/**
 * The products after the ones the shopper already has on screen. It continues by excluding what was shown rather than
 * by page number: the order moves with stock and price, so an OFFSET taken from a later snapshot can repeat a product
 * and skip another. A listing opened at `?page=N` passes the products ahead of it as already shown.
 */
export async function fetchEligibleOffersPage({
  campaignId,
  shownProductIds,
}: {
  campaignId: string;
  shownProductIds: readonly string[];
}): Promise<EligibleOffersNextPageResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId) || !Array.isArray(shownProductIds)) return NEXT_PAGE_FAILED;
  // `page` only picks the rate-limit bucket and the retry link; a cursor request always uses the continuation budget.
  const { view } = await listForCart(campaignId, 2, { throwOnNotFound: false, cursor: { excludeProductIds: shownProductIds } });
  if (view.limited) {
    return { ...NEXT_PAGE_FAILED, limited: true, error: "Gợi ý ưu đãi đang có quá nhiều lượt truy cập, nàng thử lại sau ít phút nhé." };
  }
  if (view.retryHref) return { ...NEXT_PAGE_FAILED, error: "Đang tải chậm hơn bình thường, nàng thử lại nhé." };
  if (!view.listing) return NEXT_PAGE_FAILED;
  return {
    ok: true,
    cards: view.listing.cards,
    consumedProductIds: view.consumedProductIds ?? [],
    totalCount: view.listing.totalCount,
    hasNext: view.listing.page < view.listing.totalPages,
  };
}

/**
 * One refresh asks for this many products at most. The catalog reads a few dozen at a time (48), so the server walks
 * them in that size; a single call spends a single rate-limit token however many of those reads it makes.
 */
const REFRESH_CARDS_MAX_IDS = 240;
const CATALOG_READ_MAX_IDS = 48;

export type EligibleOffersRefreshedCards = Readonly<{
  /** False when nothing is known (no cart, no offer, rate limit, a failed read): the caller keeps what it holds. */
  ok: boolean;
  cards: EligibleOffersNextPageResult["cards"];
}>;

/**
 * Fresh card models (price, sale badge, stock labels) for products the shopper has already loaded, and which of them the
 * offer still lists. A server refresh re-renders the first page only, so the pages appended since keep what they were
 * drawn with until they are asked for again here. This is a public endpoint like any server action, so it is held to the
 * listing's own gates: a guest cart that exists and has items, a trusted browser request, the continuation budget, and
 * only ids that the offer's scope lists for that cart (addable, publicly listed, in scope). An id outside that is
 * not drawn and not mentioned. Nothing here is a quote.
 */
export async function fetchEligibleOffersCards({
  campaignId,
  productIds,
}: {
  campaignId: string;
  productIds: readonly string[];
}): Promise<EligibleOffersRefreshedCards> {
  const none = { ok: false, cards: [] } as const;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId) || !Array.isArray(productIds) || productIds.length === 0
    || productIds.length > REFRESH_CARDS_MAX_IDS
    || !productIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) return none;
  try {
    const store = await cookies();
    if (!readAnonymousCartCookie(store)) return none;
    const auth = readAuthServerConfig();
    const requestHeaders = await headers();
    if (!isTrustedUpsellBrowseRequest(requestHeaders, auth.baseURL)) return none;
    const shopId = readPancakeShopId();
    if (!isPromotionUpsellEnabled(shopId)) return none;
    const release = upsellReadGate.tryAcquire();
    if (!release) return none;
    let allowed: readonly string[] | null;
    const now = new Date();
    try {
      const clientKey = deriveGuestCheckoutClientKey(requestHeaders, auth);
      if (!(await createGuestCheckoutRateLimiter(prisma).consumeUpsellPageClient({ clientKey }))) return none;
      allowed = await createPromotionUpsellService(prisma, store, { shopId, secret: auth.secret }).getScopeMembers(campaignId, productIds, now);
    } finally {
      release();
    }
    if (allowed === null) return none;
    const cards: EligibleOffersNextPageResult["cards"][number][] = [];
    for (let at = 0; at < allowed.length; at += CATALOG_READ_MAX_IDS) {
      const catalog = await listConfiguredStorefrontListingProductsByIds({ ids: allowed.slice(at, at + CATALOG_READ_MAX_IDS), now });
      cards.push(...buildFlashSaleViewModel({
        basePath: "/offers/eligible",
        products: catalog.products,
        totalCount: catalog.products.length,
        totalPages: 1,
        page: 1,
        pageSize: CATALOG_READ_MAX_IDS,
        selectEventBySlug: new Map(),
        pricingRule: catalog.pricingRule,
      }).cards);
    }
    return { ok: true, cards };
  } catch {
    return none;
  }
}

export async function loadEligibleOffersRoute({ searchParams }: EligibleOffersRouteProps): Promise<RouteHandle<EligibleOffersViewModel>> {
  await connection();
  const params = await searchParams;
  let page: number;
  try { page = parseStorefrontListingPage(params); } catch (error) { if (error instanceof RangeError) notFound(); throw error; }
  const campaign = typeof params.campaign === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(params.campaign) ? params.campaign : null;
  const { view, refreshAfterMs } = campaign ? await listForCart(campaign, page) : fallback(empty);
  return sealRoute({
    data: view,
    refreshAfterMs,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
