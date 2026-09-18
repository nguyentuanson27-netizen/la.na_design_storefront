import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMerchantFeedCoordinator } from "../../src/commerce/merchant-feed-coordinator.ts";
import {
  MAX_MERCHANT_DB_ROUND_TRIPS,
  MAX_MERCHANT_OFFERS,
} from "../../src/commerce/merchant-feed-limits.ts";
import { createMerchantOfferRepository } from "../../src/commerce/merchant-offer-repository.ts";

const KEY = "merchant-feed:rss-v1:shop:920007";

function candidateVariants(variantCount: number) {
  return Array.from({ length: variantCount }, (_, index) => ({
    id: `variant-internal-${index}`,
    productId: "product-internal-1",
    pancakeVariationId: `variation-${String(index).padStart(5, "0")}`,
    pancakeDisplayId: `MPN-${index}`,
    color: "Black",
    size: "M",
    pancakeRetailPrice: 100_000,
    pancakeRetailPriceAfterDiscount: null,
    pancakeImageUrls: ["https://cdn.example.test/product.jpg"],
  }));
}

describe("Merchant public-feed repository query envelope", () => {
  it("loads 5,000 variants completely while the whole generation stays at nine DB operations", async () => {
    const calls = new Map<string, number>();
    const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    const counted = <T>(name: string, value: T) => async () => {
      count(name);
      return value;
    };
    const variants = candidateVariants(MAX_MERCHANT_OFFERS);

    const repository = createMerchantOfferRepository({
      productMirror: {
        findMany: counted("productMirror", [
          {
            id: "product-internal-1",
            pancakeProductId: "product-1",
            slug: "product-1",
            name: "Product 1",
            primaryImageUrl: "https://cdn.example.test/product.jpg",
          },
        ]),
      },
      variantMirror: { findMany: counted("variantMirror", variants) },
      warehouseStock: {
        findMany: counted(
          "warehouseStock",
          variants.map((variant) => ({
            variantId: variant.id,
            pancakeWarehouseId: "warehouse-1",
            quantity: 1,
          })),
        ),
      },
      compositeComponentMirror: { findMany: counted("compositeComponentMirror", []) },
      // I9 — the availability-cycle read. One flat query for the whole page, exactly like the
      // warehouse and promotion reads, so it cannot become per-offer as the catalog grows.
      variantAvailabilityCycle: { findMany: counted("variantAvailabilityCycle", []) },
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM "ProductMirror" p')) {
          count("productFactsJoin");
          return [
            {
              productId: "product-internal-1",
              contentStatus: "PUBLISHED",
              editorialDescription: "Published description",
              merchantFactsPresent: false,
              merchantGender: null,
              merchantAgeGroup: null,
              merchantCondition: null,
            },
          ];
        }
        if (sql.includes('FROM "PromotionTarget" t')) {
          count("promotionJoin");
          return [
            {
              campaignId: "campaign-1",
              productId: null,
              variantId: variants[0]!.id,
              name: "Campaign 1",
              kind: "PROMOTION",
              discountType: "PERCENTAGE",
              percentageValue: 10,
              fixedPriceVnd: null,
              startsAt: null,
              endsAt: null,
            },
          ];
        }
        throw new Error("unexpected Merchant raw query");
      },
    } as never);

    let loadedVariantCount = 0;
    const coordinator = createMerchantFeedCoordinator({
      key: KEY,
      readPricingRevision: async () => {
        count("promotionPricingRevision");
        return BigInt(7);
      },
    });

    const result = await coordinator.get({
      generate: async () => {
        const products = await repository.readCandidateProducts({
          shopId: 920007,
          now: new Date("2026-09-05T00:00:00Z"),
        });
        loadedVariantCount = products[0]?.variations.length ?? 0;
        return {
          ok: true as const,
          body: "<feed />",
          byteLength: 8,
          offerCount: loadedVariantCount,
          nextPricingTransitionAtMs: null,
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(loadedVariantCount, MAX_MERCHANT_OFFERS);
    const dbOperations = [...calls.values()].reduce((sum, callCount) => sum + callCount, 0);
    assert.equal(dbOperations, MAX_MERCHANT_DB_ROUND_TRIPS);
    assert.deepEqual(Object.fromEntries(calls), {
      promotionPricingRevision: 2,
      productMirror: 1,
      variantMirror: 1,
      productFactsJoin: 1,
      warehouseStock: 1,
      compositeComponentMirror: 1,
      promotionJoin: 1,
      // I9 — one per generation, not one per offer. That is the property this envelope exists to
      // hold, and the reason the constant could move from eight to nine without weakening it.
      variantAvailabilityCycle: 1,
    });
  });
});
