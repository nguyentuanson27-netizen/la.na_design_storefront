import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";

import {
  createMerchantFeedCoordinator,
  type MerchantFeedCoordinatorResult,
  type MerchantFeedEvent,
  type MerchantFeedFailureClass,
} from "./merchant-feed-coordinator.ts";
import {
  MerchantFeedByteOverflowError,
  MerchantFeedOfferOverflowError,
} from "./merchant-feed-serializer.ts";
import {
  buildMerchantParentItems,
  serializeGoogleMerchantParentFeed,
} from "./merchant-parent-feed.ts";
import { createMerchantOfferRepository, MerchantOfferReadError } from "./merchant-offer-repository.ts";
import { readStorefrontOrigin } from "./storefront-origin.ts";

const MERCHANT_FEED_SCHEMA_VERSION = "parent-rss-v1";
const PROMOTION_PRICING_REVISION_ID = "current";

function observeMerchantFeed(event: MerchantFeedEvent): void {
  console.info(`[merchant-feed] ${event}`);
}

async function readPromotionPricingRevision(): Promise<bigint> {
  const row = await prisma.promotionPricingRevision.findUnique({
    where: { id: PROMOTION_PRICING_REVISION_ID },
    select: { revision: true },
  });
  if (row === null) {
    throw new Error("Promotion pricing revision row is missing; migrations are not deployed");
  }
  return row.revision;
}

let runtimeCoordinator:
  | Readonly<{
      key: string;
      coordinator: ReturnType<typeof createMerchantFeedCoordinator>;
    }>
  | undefined;

function coordinatorFor(key: string) {
  if (runtimeCoordinator === undefined) {
    runtimeCoordinator = Object.freeze({
      key,
      coordinator: createMerchantFeedCoordinator({
        key,
        readPricingRevision: readPromotionPricingRevision,
        observe: observeMerchantFeed,
      }),
    });
  } else if (runtimeCoordinator.key !== key) {
    throw new Error("Merchant feed trusted cache key changed during the process lifetime");
  }
  return runtimeCoordinator.coordinator;
}

function classifyGenerationFailure(error: unknown): MerchantFeedFailureClass {
  if (error instanceof MerchantFeedOfferOverflowError) return "OFFER_OVERFLOW";
  if (error instanceof MerchantFeedByteOverflowError) return "BYTE_OVERFLOW";
  if (
    error instanceof MerchantOfferReadError &&
    error.message.includes("query envelope")
  ) {
    return "QUERY_BUDGET_FAILURE";
  }
  return "GENERATION_FAILURE";
}

export async function getMerchantFeed(): Promise<MerchantFeedCoordinatorResult> {
  let shopId: number;
  let origin: string;
  try {
    shopId = readPancakeShopId();
    origin = readStorefrontOrigin();
  } catch {
    return Object.freeze({
      ok: false,
      failureClass: "GENERATION_FAILURE" as const,
      retryAfterSeconds: 60,
      backoff: false,
    });
  }

  const key = `merchant-feed:${MERCHANT_FEED_SCHEMA_VERSION}:shop:${shopId}`;
  let coordinator: ReturnType<typeof createMerchantFeedCoordinator>;
  try {
    coordinator = coordinatorFor(key);
  } catch {
    return Object.freeze({
      ok: false,
      failureClass: "GENERATION_FAILURE" as const,
      retryAfterSeconds: 60,
      backoff: false,
    });
  }

  return coordinator.get({
    generate: async () => {
      try {
        const snapshot = await createMerchantOfferRepository(prisma).readMerchantFeedSnapshot({
          shopId,
          origin,
        });
        const mapped = snapshot.mapping;

        if (mapped.market.status !== "APPROVED" || mapped.activationBlockedReasons.length > 0) {
          return Object.freeze({ ok: false as const, failureClass: "MARKET_UNRESOLVED" as const });
        }

        const items = buildMerchantParentItems(snapshot.products, origin);
        const serialized = serializeGoogleMerchantParentFeed({
          items,
          market: mapped.market.policy,
          origin,
        });
        return Object.freeze({
          ok: true as const,
          ...serialized,
          nextPricingTransitionAtMs: snapshot.nextPricingTransitionAtMs,
        });
      } catch (error) {
        return Object.freeze({ ok: false as const, failureClass: classifyGenerationFailure(error) });
      }
    },
  });
}