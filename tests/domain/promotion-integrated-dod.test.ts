import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import { buildStorefrontCartLines } from "../../src/commerce/storefront-cart.ts";
import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { calculateGuestShippingFeeVnd } from "../../src/commerce/guest-shipping-policy.ts";
import {
  buildMetaAddToCartPixelParameters,
  buildMetaPurchasePixelParameters,
} from "../../src/commerce/meta-pixel-parameters.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import { buildStorefrontVariantOptions } from "../../src/commerce/storefront-product.ts";
import { createMerchantFeedCoordinator } from "../../src/commerce/merchant-feed-coordinator.ts";
import { createMerchantFeedGetHandler } from "../../src/commerce/merchant-feed-http.ts";
import { isPromotionActivationEnabled } from "../../src/commerce/promotion-activation.ts";
import { publishPromotionCampaign } from "../../src/commerce/promotion-activation-service.ts";
import { evaluateCampaignRuntimeHealth } from "../../src/commerce/promotion-runtime-health.ts";
import {
  describeCampaignRuntimeHealth,
  emitPromotionSignal,
  MAX_SIGNAL_UTF8_BYTES,
} from "../../src/operations/promotion-observability.ts";
import {
  readSearchExposure,
  shouldNoIndexRequest,
  validateSearchExposureForRelease,
} from "../../src/seo/search-exposure.ts";
import { buildRobotsDocument } from "../../src/seo/robots-policy.ts";
import {
  readTrackingConfig,
  resolveTrackingRuntime,
  shouldLoadGoogleTagManager,
} from "../../src/tracking/config.ts";

describe("U43 / G3: Promotion Final Integrated Definition of Done", () => {
  const NOW = new Date("2026-09-08T12:00:00.000Z");

  const sampleCampaign: ApplicablePromotionCampaign = {
    id: "camp-dod-1",
    name: "Integrated DoD 20% Off",
    kind: "FLASH_SALE",
    discountType: "PERCENTAGE",
    percentageValue: 20,
    fixedPriceVnd: null,
    startsAt: new Date(NOW.getTime() - 3_600_000),
    endsAt: new Date(NOW.getTime() + 3_600_000),
  };

  it("converges PDP projection, cart, checkout, and direct Meta builders on one effective price", () => {
    const basePrice = 500_000;
    const campaignsByVariantId = new Map([["var-local-01", [sampleCampaign]]]);
    const pricingRule = buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW });

    const variant = {
      id: "var-local-01",
      pancakeVariationId: "pan-var-01",
      color: "Đen",
      size: "L",
      sellableStock: 10,
      retailPrice: basePrice,
      retailPriceAfterDiscount: null,
    };

    const pdpOptions = buildStorefrontVariantOptions([variant], pricingRule);
    assert.equal(pdpOptions.length, 1);
    assert.equal(pdpOptions[0]!.price, 400_000);
    assert.equal(pdpOptions[0]!.basePriceVnd, 500_000);
    assert.equal(pdpOptions[0]!.isDiscounted, true);

    const cartLines = buildStorefrontCartLines({
      items: [{ variantId: variant.id, quantity: 2 }],
      products: [
        {
          pancakeProductId: "pan-prod-01",
          slug: "ao-polo",
          name: "Áo Polo",
          primaryImageUrl: null,
          isPresent: true,
          isActive: true,
          variants: [{ ...variant, isPresent: true, isActive: true }],
        },
      ],
      pricingRule,
    });

    assert.equal(cartLines.length, 1);
    assert.equal(cartLines[0]!.price, 400_000);
    assert.equal(cartLines[0]!.pancakeVariationId, "pan-var-01");
    assert.equal(cartLines[0]!.pancakeProductId, "pan-prod-01");

    const quoteFacts = buildRenderedCheckoutQuoteFacts(cartLines);
    assert.ok(quoteFacts);
    assert.equal(quoteFacts.merchandiseSubtotalVnd, 800_000);
    assert.equal(quoteFacts.items[0]?.unitPriceVnd, 400_000);
    assert.equal(quoteFacts.items[0]?.variantExternalId, "pan-var-01");

    const expectedShipping = calculateGuestShippingFeeVnd({
      subtotalVnd: 800_000,
      totalQuantity: 2,
    });
    assert.equal(quoteFacts.shippingFeeVnd, expectedShipping);
    assert.equal(quoteFacts.totalVnd, 800_000 + expectedShipping);

    const addToCart = buildMetaAddToCartPixelParameters({
      slug: "ao-polo",
      productName: "Áo Polo",
      committedUnitPriceVnd: cartLines[0]!.price,
    });
    assert.ok(addToCart);
    assert.equal(addToCart.value, 400_000);
    assert.deepEqual(addToCart.content_ids, ["ao-polo"]);

    const purchase = buildMetaPurchasePixelParameters({
      valueVnd: quoteFacts.totalVnd,
      contents: [{ id: "ao-polo", quantity: 2, itemPrice: 400_000 }],
    });
    assert.ok(purchase);
    assert.equal(purchase.value, quoteFacts.totalVnd);
    assert.deepEqual(purchase.contents, [{ id: "ao-polo", quantity: 2, item_price: 400_000 }]);
  });

  it("enforces the runtime-health UTF-8 byte budget with realistic bounded identifiers", () => {
    const id128 = (prefix: string) => `${prefix}${"x".repeat(128 - prefix.length)}`;
    const affected = Array.from({ length: 50 }, (_, index) => ({
      variantId: id128(`v${index}-`),
      reason: "PROMOTION_CONFLICT" as const,
      conflictingCampaignIds: Array.from({ length: 10 }, (_, conflictIndex) =>
        id128(`c${index}-${conflictIndex}-`),
      ),
    }));

    const signal = describeCampaignRuntimeHealth({
      campaignId: id128("campaign-"),
      status: "FULLY_INVALID",
      coveredVariants: 5_000,
      discountedVariants: 0,
      affectedVariants: 5_000,
      affected,
      affectedTruncated: true,
    });

    const lines: string[] = [];
    emitPromotionSignal(signal, (line) => lines.push(line));

    assert.equal(lines.length, 1);
    assert.ok(Buffer.byteLength(lines[0]!, "utf8") < MAX_SIGNAL_UTF8_BYTES);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.name, "promotion.runtime_health");
    assert.equal(parsed.status, "FULLY_INVALID");
    assert.equal(parsed.affectedVariants, 5_000);
  });

  it("publishes a scheduled campaign then evaluates it as ACTIVE when its window opens", async () => {
    let campaign = {
      id: "camp-prod-integrated",
      name: "Integrated Health Campaign",
      kind: "PROMOTION" as const,
      discountType: "PERCENTAGE" as const,
      percentageValue: 25,
      fixedPriceVnd: null,
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-10-15T00:00:00Z"),
      isEnabled: false,
      enabledAt: null as Date | null,
      disabledAt: null as Date | null,
      targets: [{ productId: "prod-int-1", variantId: null }],
    };
    const variants = [{ id: "var-int-1", productId: "prod-int-1", pancakeRetailPrice: 200_000 }];

    const mockTx = {
      promotionPricingRevision: { findUniqueOrThrow: async () => ({ campaignMutationFrozen: false }) },
      $queryRaw: async () => [{ revision: BigInt(10) }],
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 1,
      promotionCampaign: {
        findUnique: async () => campaign,
        findMany: async () => [],
        update: async ({ data }: { data: Partial<typeof campaign> }) => {
          campaign = { ...campaign, ...data };
          return campaign;
        },
      },
      productMirror: {
        findMany: async () => [{ id: "prod-int-1" }],
      },
      variantMirror: {
        findMany: async () => variants,
      },
    };

    const mockClient = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
      promotionCampaign: {
        findUnique: async () => campaign,
      },
      variantMirror: {
        findMany: async () => variants,
      },
    };

    const published = await publishPromotionCampaign({
      campaignId: campaign.id,
      now: new Date("2026-09-08T00:00:00Z"),
      session: { user: { id: "admin-1", role: "ADMIN" }, session: { id: "sess-1" } },
      client: mockClient as unknown as Parameters<typeof publishPromotionCampaign>[0]["client"],
      env: { LA_PROMOTION_ACTIVATION_ENABLED: "true" },
      writer: () => {},
    });

    assert.equal(published.ok, true);
    assert.equal(campaign.isEnabled, true, "the fake must model the committed persisted state");

    const health = await evaluateCampaignRuntimeHealth({
      campaignId: campaign.id,
      client: mockClient as unknown as Parameters<typeof evaluateCampaignRuntimeHealth>[0]["client"],
      now: new Date("2026-10-05T00:00:00Z"),
      writer: () => {},
    });

    assert.ok(health);
    assert.equal(health.status, "HEALTHY");
    assert.equal(health.coveredVariants, 1);
    assert.equal(health.discountedVariants, 1);
  });

  it("keeps Merchant cache linearized to the durable promotion pricing revision", async () => {
    let revision = BigInt(1);
    let generatorCalls = 0;
    const coordinator = createMerchantFeedCoordinator({
      key: "merchant-feed-g3",
      readPricingRevision: async () => revision,
      now: () => NOW.getTime(),
    });

    const generate = async (body: string) => {
      generatorCalls += 1;
      return {
        ok: true as const,
        body,
        byteLength: Buffer.byteLength(body),
        offerCount: 1,
        nextPricingTransitionAtMs: null,
      };
    };

    const first = await coordinator.get({ generate: () => generate("<feed>r1</feed>") });
    assert.equal(first.ok, true);
    const cached = await coordinator.get({ generate: () => generate("<feed>unexpected</feed>") });
    assert.equal(cached.ok, true);
    assert.equal(generatorCalls, 1);

    revision = BigInt(2);
    const refreshed = await coordinator.get({ generate: () => generate("<feed>r2</feed>") });
    assert.equal(refreshed.ok, true);
    assert.equal(generatorCalls, 2);
    if (refreshed.ok) assert.equal(refreshed.body, "<feed>r2</feed>");
  });

  it("documents the final rollback procedure that recreates app after env changes", () => {
    const runbook = readFileSync(
      new URL("../../docs/operations/promotion-rollback-runbook.md", import.meta.url),
      "utf8",
    );

    assert.match(runbook, /docker compose up -d --no-deps --force-recreate app/);
    assert.match(
      runbook,
      /docker compose exec app node -e 'if \(process\.env\.LA_PROMOTION_ACTIVATION_ENABLED !== "false"\) process\.exit\(1\)'/,
    );

    const bashBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
    assert.equal(
      bashBlocks.some((block) => /docker compose restart app/.test(block)),
      false,
      "an executable restart command would preserve the old container environment",
    );

    for (const reason of [
      "PRICE_CHANGED",
      "PROOF_MISSING",
      "PROOF_OVERSIZED",
      "PROOF_MALFORMED",
      "PROOF_UNVERIFIED",
    ]) {
      assert.ok(runbook.includes(`\`${reason}\``));
    }
    assert.equal(runbook.includes("WRONG_CART"), false);
  });

  it("keeps promotion and organic-search gates independent and default-off", () => {
    assert.equal(isPromotionActivationEnabled({}), false);
    assert.equal(isPromotionActivationEnabled({ LA_PROMOTION_ACTIVATION_ENABLED: "false" }), false);

    const promoOnSearchOff = {
      LA_PROMOTION_ACTIVATION_ENABLED: "true",
      SEARCH_INDEXING_ENABLED: "false",
      APP_DOMAIN: "la-clothing.example.com",
    };
    assert.equal(isPromotionActivationEnabled(promoOnSearchOff), true);

    const exposure = readSearchExposure(promoOnSearchOff);
    assert.equal(exposure.indexingEnabled, false);
    assert.equal(
      shouldNoIndexRequest({ indexingEnabled: exposure.indexingEnabled, pathname: "/shop", search: "" }),
      true,
    );
    assert.equal(buildRobotsDocument(exposure).sitemap, undefined);

    assert.throws(
      () => validateSearchExposureForRelease({
        APP_DOMAIN: "la.lanadesign.vn",
        SEARCH_INDEXING_ENABLED: "true",
      }),
      /Search indexing cannot be enabled on the temporary production storefront origin/,
    );
  });

  it("keeps GTM fail-closed pending a reviewed immutable container version", () => {
    const defaultRuntime = resolveTrackingRuntime(readTrackingConfig({}));
    assert.equal(defaultRuntime.loadsGoogleTagManager, false);
    assert.equal(shouldLoadGoogleTagManager(defaultRuntime), false);

    const requestedLiveRuntime = resolveTrackingRuntime({
      desiredMode: "live",
      containerId: "GTM-TEST1234",
    });
    assert.equal(shouldLoadGoogleTagManager(requestedLiveRuntime), false);
  });

  it("keeps the Merchant HTTP route fail-closed while market authority is unresolved", async () => {
    const handler = createMerchantFeedGetHandler(async () => ({
      ok: false,
      failureClass: "MARKET_UNRESOLVED",
      retryAfterSeconds: 60,
      backoff: false,
    }));

    const response = await handler(
      new Request("https://la-clothing.example.com/api/feeds/google-merchant.xml"),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-la-merchant-feed-failure"), "MARKET_UNRESOLVED");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
