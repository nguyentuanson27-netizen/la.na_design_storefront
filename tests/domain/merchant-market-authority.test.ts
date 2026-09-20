import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  APPROVED_O2_MARKET_POLICY,
  MERCHANT_MARKET_UNRESOLVED,
  mapMerchantOffers,
  resolveMerchantMarketFromEnvironment,
  type MerchantCandidateProduct,
  type MerchantCandidateVariation,
  type MerchantMarketEnvironment,
} from "../../src/commerce/merchant-offer-mapper.ts";
import { getMerchantFeed } from "../../src/commerce/merchant-feed-service.ts";
import { serializeMerchantFeed } from "../../src/commerce/merchant-feed-serializer.ts";
import { readSearchExposure } from "../../src/seo/search-exposure.ts";
import { readProjectConfig } from "../../src/config/project-config.ts";
import { validateReleaseEnvironment } from "../../src/operations/release-readiness.ts";
import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import type { StorefrontProductProjection } from "../../src/commerce/storefront-projection.ts";
import { fixtureAvailability } from "../fixtures/storefront-projection-option.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;
type _MapperHasNoCallerMarketConfig = Assert<
  Equal<keyof Parameters<typeof mapMerchantOffers>[0], "products" | "origin">
>;
type _FeedHasNoCallerMarketConfig = Assert<Equal<Parameters<typeof getMerchantFeed>, []>>;

const ORIGIN = "https://shop.example.test";
const CANONICAL_ENV: MerchantMarketEnvironment = {
  LA_MERCHANT_TARGET_COUNTRY: "VN",
  LA_MERCHANT_CONTENT_LANGUAGE: "vi",
  LA_MERCHANT_CURRENCY: "VND",
};

function createCandidateProduct(): MerchantCandidateProduct {
  const projection: StorefrontProductProjection = {
    mode: "standalone",
    options: [
      {
        id: "var-1",
        pancakeVariationId: "pv-1",
        color: "Đen",
        size: "M",
        price: 450_000,
        basePriceVnd: 450_000,
        isDiscounted: false,
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
        availability: fixtureAvailability({
          purchasable: true,
          isPreorderSale: false,
          unavailableReason: null,
        }),
        kindKey: null,
        kindLabel: null,
      },
    ],
  };

  const variation: MerchantCandidateVariation = {
    variantId: "var-1",
    pancakeVariationId: "pv-1",
    pancakeDisplayId: "VN-A1-M",
    isComposite: false,
    stockQuantity: 10,
  };

  return {
    pancakeProductId: "prod-1",
    slug: "ao-so-mi-oxford",
    name: "Áo sơ mi Oxford",
    publishedDescription: "Áo sơ mi vải cotton cao cấp.",
    media: resolveStorefrontProductMedia({
      productName: "Áo sơ mi Oxford",
      primaryImageUrl: "https://content.pancake.vn/web-media/1/2/3/primary.jpg",
      variantImageUrls: [["https://content.pancake.vn/web-media/1/2/3/variant-1.jpg"]],
    }),
    galleryIndexByVariantId: new Map([["var-1", 1]]),
    projection,
    apparelOverrides: { gender: null, ageGroup: null, condition: null },
    variations: [variation],
  };
}

function withMerchantEnvCleared<T>(run: () => T): T {
  const keys = [
    "LA_MERCHANT_TARGET_COUNTRY",
    "LA_MERCHANT_CONTENT_LANGUAGE",
    "LA_MERCHANT_CURRENCY",
    "LA_MERCHANT_COUNTRY",
    "LA_MERCHANT_LANGUAGE",
    "LA_MERCHANT_MARKET",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("U41 / M5a: trusted server-owned Merchant market authority", () => {
  it("resolves only the canonical reviewed Vietnam / vi / VND server configuration", () => {
    const resolved = resolveMerchantMarketFromEnvironment(CANONICAL_ENV);
    assert.equal(resolved.status, "APPROVED");
    if (resolved.status === "APPROVED") {
      assert.deepEqual(resolved.policy, APPROVED_O2_MARKET_POLICY);
    }

    for (const env of [
      {},
      { LA_MERCHANT_TARGET_COUNTRY: "VN" },
      {
        LA_MERCHANT_TARGET_COUNTRY: "vn",
        LA_MERCHANT_CONTENT_LANGUAGE: "vi",
        LA_MERCHANT_CURRENCY: "VND",
      },
      {
        LA_MERCHANT_TARGET_COUNTRY: "US",
        LA_MERCHANT_CONTENT_LANGUAGE: "en",
        LA_MERCHANT_CURRENCY: "USD",
      },
      {
        LA_MERCHANT_COUNTRY: "VN",
        LA_MERCHANT_LANGUAGE: "vi",
        LA_MERCHANT_CURRENCY: "VND",
      },
      { LA_MERCHANT_MARKET: "VN:vi:VND" },
    ] satisfies MerchantMarketEnvironment[]) {
      const candidate = resolveMerchantMarketFromEnvironment(env);
      assert.equal(candidate.status, "UNRESOLVED", JSON.stringify(env));
      if (candidate.status === "UNRESOLVED") {
        assert.equal(candidate.reason, MERCHANT_MARKET_UNRESOLVED);
      }
    }
  });

  it("does not let a caller-injected env property approve the production mapper", () => {
    withMerchantEnvCleared(() => {
      const injected = {
        products: [createCandidateProduct()],
        origin: ORIGIN,
        env: CANONICAL_ENV,
      };

      const result = mapMerchantOffers(injected as unknown as Parameters<typeof mapMerchantOffers>[0]);
      assert.equal(result.market.status, "UNRESOLVED");
      assert.deepEqual(result.activationBlockedReasons, [MERCHANT_MARKET_UNRESOLVED]);
    });
  });

  it("serializes VND when the reviewed policy is explicitly supplied to the serializer boundary", () => {
    const product = createCandidateProduct();
    const offer = {
      id: "pv-1",
      itemGroupId: "prod-1",
      brand: "LA Clothing" as const,
      mpn: "VN-A1-M",
      title: product.name,
      description: product.publishedDescription!,
      link: `${ORIGIN}/shop/${product.slug}?variant=pv-1`,
      imageLink: product.media.primary!.url,
      additionalImageLinks: [],
      availability: "in_stock" as const,
      priceVnd: 450_000,
      gender: "male" as const,
      ageGroup: "adult" as const,
      condition: "new" as const,
      color: "Đen",
      size: "M",
      availabilityDate: null,
    };

    const feed = serializeMerchantFeed({
      offers: [offer],
      market: APPROVED_O2_MARKET_POLICY,
      origin: ORIGIN,
    });
    assert.match(feed.body, /<g:price>450000 VND<\/g:price>/);
    assert.match(feed.body, /<g:id>pv-1<\/g:id>/);
  });

  it("keeps Merchant configuration independent from search indexing", () => {
    const env = {
      APP_DOMAIN: "shop.example.test",
      SEARCH_INDEXING_ENABLED: "false",
      ...CANONICAL_ENV,
    };
    assert.equal(resolveMerchantMarketFromEnvironment(env).status, "APPROVED");
    assert.equal(readSearchExposure(env).indexingEnabled, false);

    // The release preflight now also checks that the deployment identity mirrors
    // project.config.json, so this fixture states the project's own identity. What it is exercising
    // is unchanged: Merchant market approval does not depend on search indexing.
    const projectConfig = readProjectConfig();
    const releaseSummary = validateReleaseEnvironment({
      DATABASE_URL: `postgresql://user:pass@localhost:5432/${projectConfig.databaseName}`,
      APP_DOMAIN: projectConfig.productionDomain,
      SEARCH_INDEXING_ENABLED: "false",
      BETTER_AUTH_SECRET: "release-only-secret-0123456789abcdef",
      BETTER_AUTH_URL: `https://${projectConfig.productionDomain}`,
      BETTER_AUTH_IP_HEADER: "cf-connecting-ip",
      PANCAKE_API_KEY: "secret-key",
      PANCAKE_SHOP_ID: "920007",
      RESEND_API_KEY: "re_ci-only-contact-key",
      LA_SHIPPING_FEE_VND: "30000",
      LA_FREE_SHIPPING_SUBTOTAL_VND: "1000000",
      LA_FREE_SHIPPING_MIN_QUANTITY: "3",
      ...CANONICAL_ENV,
    });
    assert.equal(releaseSummary.searchIndexingEnabled, false);
    assert.equal(releaseSummary.merchantMarketStatus, "APPROVED");
  });

  it("pins the canonical VPS deployment template to the reviewed server-owned market", () => {
    const envExample = readFileSync(
      new URL("../../deploy/vps/env.example", import.meta.url),
      "utf8",
    );
    assert.match(envExample, /^LA_MERCHANT_TARGET_COUNTRY=VN$/m);
    assert.match(envExample, /^LA_MERCHANT_CONTENT_LANGUAGE=vi$/m);
    assert.match(envExample, /^LA_MERCHANT_CURRENCY=VND$/m);
    assert.equal(envExample.includes("LA_MERCHANT_COUNTRY="), false);
    assert.equal(envExample.includes("LA_MERCHANT_LANGUAGE="), false);
    assert.equal(envExample.includes("LA_MERCHANT_MARKET="), false);
  });

  it("pins the Merchant runtime smoke to an approved server env and a request-invariant 200 feed", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/merchant-feed-runtime.yml", import.meta.url),
      "utf8",
    );
    assert.match(workflow, /LA_MERCHANT_TARGET_COUNTRY:\s*"VN"/);
    assert.match(workflow, /LA_MERCHANT_CONTENT_LANGUAGE:\s*"vi"/);
    assert.match(workflow, /LA_MERCHANT_CURRENCY:\s*"VND"/);
    assert.match(workflow, /test "\$first_status" = "200"/);
    assert.match(workflow, /test "\$second_status" = "200"/);
    assert.match(workflow, /cmp -s "\$RUNNER_TEMP\/feed-first\.txt" "\$RUNNER_TEMP\/feed-second\.txt"/);
  });
});
