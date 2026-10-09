/**
 * Public, read-only Facebook Live / Catalog feed. Emits parent-level catalog items.
 */
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { readStorefrontOrigin } from "./storefront-origin.ts";
import { createMerchantOfferRepository, MerchantOfferReadError } from "./merchant-offer-repository.ts";
import { createMerchantFeedCoordinator, type MerchantFeedCoordinatorResult } from "./merchant-feed-coordinator.ts";
import { MerchantFeedByteOverflowError, MerchantFeedOfferOverflowError } from "./merchant-feed-serializer.ts";
import {
  buildMerchantParentItems,
  serializeFacebookParentFeed,
} from "./merchant-parent-feed.ts";

const FEED_SCHEMA_VERSION = "parent-rss-v2";
const PROMOTION_PRICING_REVISION_ID = "current";

async function readPricingRevision(): Promise<bigint> {
  const row = await prisma.promotionPricingRevision.findUnique({
    where: { id: PROMOTION_PRICING_REVISION_ID },
    select: { revision: true },
  });
  if (row === null) throw new Error("Promotion pricing revision row is missing");
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
        readPricingRevision,
        observe: (event) => console.info(`[facebook-live-feed] ${event}`),
      }),
    });
  } else if (runtimeCoordinator.key !== key) {
    throw new Error("Facebook Live feed cache key changed during process lifetime");
  }
  return runtimeCoordinator.coordinator;
}

export async function getFacebookLiveFeed(): Promise<MerchantFeedCoordinatorResult> {
  let shopId: number;
  let origin: string;
  try {
    shopId = readPancakeShopId();
    origin = readStorefrontOrigin();
  } catch {
    return { ok: false, failureClass: "GENERATION_FAILURE", retryAfterSeconds: 60, backoff: false };
  }

  let coordinator: ReturnType<typeof createMerchantFeedCoordinator>;
  try {
    coordinator = coordinatorFor(`facebook-live:${FEED_SCHEMA_VERSION}:shop:${shopId}`);
  } catch {
    return { ok: false, failureClass: "GENERATION_FAILURE", retryAfterSeconds: 60, backoff: false };
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
          return { ok: false as const, failureClass: "MARKET_UNRESOLVED" as const };
        }

        const items = buildMerchantParentItems(snapshot.products, origin);
        const feed = serializeFacebookParentFeed({
          items,
          market: mapped.market.policy,
          origin,
        });
        return { ok: true as const, ...feed, nextPricingTransitionAtMs: snapshot.nextPricingTransitionAtMs };
      } catch (error) {
        if (error instanceof MerchantFeedOfferOverflowError) {
          return { ok: false as const, failureClass: "OFFER_OVERFLOW" as const };
        }
        if (error instanceof MerchantFeedByteOverflowError) {
          return { ok: false as const, failureClass: "BYTE_OVERFLOW" as const };
        }
        if (error instanceof MerchantOfferReadError && error.message.includes("query envelope")) {
          return { ok: false as const, failureClass: "QUERY_BUDGET_FAILURE" as const };
        }
        return { ok: false as const, failureClass: "GENERATION_FAILURE" as const };
      }
    },
  });
}