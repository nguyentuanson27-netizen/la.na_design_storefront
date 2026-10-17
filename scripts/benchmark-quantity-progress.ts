/** Run: node --env-file=.env.test.local --experimental-strip-types scripts/benchmark-quantity-progress.ts
 * Pricing/progress CPU at the supported 50-campaign × 50-line bound. Reads and capacity are fixtures;
 * this is not an end-to-end database/checkout latency measurement. Optional argv[2]: baseline module URL,
 * or --repository to include the real cart capacity projection (with fixture reads, 50 products).
 */
import { performance } from "node:perf_hooks";
import type { GiftQuantityCandidateReadClient } from "../src/commerce/gift-quantity-candidate-repository.ts";
import type { QuoteCartLine } from "../src/commerce/gift-quantity-quote.ts";
import { createStorefrontCartRepository } from "../src/commerce/storefront-cart-repository.ts";

const repositoryMode = process.argv[2] === "--repository";
const { resolveGiftQuantityQuote } = await import(repositoryMode ? "../src/commerce/gift-quantity-quote.ts" : process.argv[2] ?? "../src/commerce/gift-quantity-quote.ts") as typeof import("../src/commerce/gift-quantity-quote.ts");
const now = new Date("2026-10-17T00:00:00Z");
const lines: QuoteCartLine[] = Array.from({ length: 50 }, (_, i) => ({
  variantId: `v${i}`, pancakeVariationId: `pv${i}`, productId: `p${i}`, quantity: 1, basePriceVnd: 100_000, legacy: null,
}));
const records = Array.from({ length: 50 }, (_, i) => ({
  id: `tier${i}`, kind: "QUANTITY_TIER", name: `Tier ${i}`, startsAt: null, endsAt: null,
  isEnabled: true, enabledAt: now, disabledAt: null, revision: 1, stackPriority: null, stackingEnabled: false,
  scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], frozenAt: null, frozenCampaignRevision: null,
  giftTrigger: null, minimumQuantity: null, minimumSubtotalVnd: null, subtotalScope: null, awardMode: null,
  maxGiftsPerOrder: null, allowDuplicateGifts: null, tierBasis: "QUANTITY", tierUnit: "PERCENTAGE",
  tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null,
  targets: [], tiers: [{ minQuantity: 51, discountValue: 10 }], giftOptions: [], stackPeers: [],
}));
const client = {
  giftQuantityCampaign: { findMany: async () => records },
  giftQuantityFrozenProduct: { findMany: async () => [] },
  productCategoryMembership: { findMany: async () => lines.map((line) => ({ productId: line.productId, categoryKey: "vayDam" })) },
} as unknown as GiftQuantityCandidateReadClient;
const products = lines.map((line) => ({
  id: line.productId, slug: line.productId, pancakeProductId: line.productId, name: line.productId,
  isPresent: true, isActive: true, primaryImageUrl: null, sellingPolicy: null,
  variants: [{ id: line.variantId, pancakeVariationId: line.pancakeVariationId, isPresent: true, isActive: true,
    color: "Trắng", size: "M", pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
    pancakeImageUrls: [], warehouseStocks: [{ quantity: 100 }], compositeComponents: [], compositeParents: [] }],
}));
const repository = createStorefrontCartRepository({
  ...client, productMirror: { findMany: async () => products }, capacityReservationResource: { findMany: async () => [] },
  variantMirror: { findMany: async () => lines.map((line) => ({ id: line.variantId, productId: line.productId })) },
  promotionTarget: { findMany: async () => [] },
} as never);
const timings: number[] = [];
let checks = 0;
for (let iteration = 0; iteration < 6; iteration++) {
  checks = 0;
  const start = performance.now();
  const env = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" };
  const quote = repositoryMode ? (await repository.getQuote({ shopId: 1, items: lines, now, env, giftClient: client })).benefits
    : await resolveGiftQuantityQuote({ lines, now, client, env,
    canAddQuantity: () => { checks++; return true; },
  });
  const elapsed = performance.now() - start;
  if (!quote.enabled || !quote.ok || quote.subtotalVnd !== 5_000_000 || quote.quantityProgress.length !== 0) throw new Error("Benchmark fixture changed");
  if (iteration > 0) timings.push(elapsed);
}
timings.sort((a, b) => a - b);
console.log(JSON.stringify({ campaigns: 50, lines: 50, samples: timings.length,
  mode: repositoryMode ? "repository-with-capacity" : "pricing-progress", capacityChecksPerQuote: repositoryMode ? undefined : checks,
  medianMs: Number(timings[2]!.toFixed(2)), maxMs: Number(timings.at(-1)!.toFixed(2)) }));
