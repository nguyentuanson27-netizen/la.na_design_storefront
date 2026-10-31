import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { readAnonymousCartCookie } from "@/commerce/anonymous-cart-cookie";
import { isTrustedUpsellBrowseRequest } from "@/commerce/checkout-upsell-http";
import { upsellReadGate } from "@/commerce/checkout-upsell-read-gate";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { createGuestCheckoutRateLimiter } from "@/commerce/guest-checkout-rate-limit";
import { createPromotionUpsellService, recordUpsellMetric, UPSELL_SCOPE_PAGE_SIZE } from "@/commerce/promotion-upsell";
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
  options?: { throwOnNotFound?: boolean },
): Promise<Loaded> {
  const throwOnNotFound = options?.throwOnNotFound ?? true;
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
      const firstPage = page === 1;
      if (!(await (firstPage ? limiter.consumeUpsellBrowseClient({ clientKey }) : limiter.consumeUpsellPageClient({ clientKey })))) return fallback({ ...empty, campaignId, limited: true });
      const cart = await prisma.cart.findFirst({
        where: { id: cartId, userId: null, expiresAt: { gt: new Date() }, items: { some: {} } },
        select: { id: true },
      });
      if (!cart) return fallback(empty);
      // Only a confirmed, unexpired guest cart may spend the shared POST upsell budget (first page only).
      if (firstPage && !(await limiter.consumeUpsellClient({ clientKey }))) return fallback({ ...empty, campaignId, limited: true });
      scope = await createPromotionUpsellService(prisma, store, { shopId, secret: auth.secret }).getScope(campaignId, page, now);
    } finally {
      release();
    }
    const retryHref = scope.retryable ? eligibleHref(campaignId, page) : null;
    if (!scope.page) return fallback({ ...empty, campaignId, retryHref });
    const totalPages = Math.ceil(scope.page.totalCount / UPSELL_SCOPE_PAGE_SIZE);
    // A page past the end is a URL that does not exist; page 1 of an empty scope is the empty state.
    if (page > Math.max(totalPages, 1)) {
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
      totalCount: scope.page.totalCount,
      totalPages,
      page,
      pageSize: UPSELL_SCOPE_PAGE_SIZE,
      selectEventBySlug: new Map(),
      pricingRule: catalog.pricingRule,
    });
    return {
      view: {
        campaignId,
        offerName: scope.page.offerName,
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
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  limited?: boolean;
  error?: string | null;
}>;

export async function fetchEligibleOffersPage({
  campaignId,
  page,
}: {
  campaignId: string;
  page: number;
}): Promise<EligibleOffersNextPageResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(campaignId) || !Number.isSafeInteger(page) || page < 1) {
    return { ok: false, cards: [], page, totalPages: 0, totalCount: 0, hasNext: false };
  }
  const { view } = await listForCart(campaignId, page, { throwOnNotFound: false });
  if (view.limited) {
    return {
      ok: false,
      cards: [],
      page,
      totalPages: 0,
      totalCount: 0,
      hasNext: false,
      limited: true,
      error: "Gợi ý ưu đãi đang có quá nhiều lượt truy cập, nàng thử lại sau ít phút nhé.",
    };
  }
  if (view.retryHref) {
    return {
      ok: false,
      cards: [],
      page,
      totalPages: 0,
      totalCount: 0,
      hasNext: false,
      error: "Đang tải chậm hơn bình thường, nàng thử lại nhé.",
    };
  }
  if (!view.listing) {
    return { ok: false, cards: [], page, totalPages: 0, totalCount: 0, hasNext: false };
  }
  return {
    ok: true,
    cards: view.listing.cards,
    page: view.listing.page,
    totalPages: view.listing.totalPages,
    totalCount: view.listing.totalCount,
    hasNext: view.listing.page < view.listing.totalPages,
  };
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
