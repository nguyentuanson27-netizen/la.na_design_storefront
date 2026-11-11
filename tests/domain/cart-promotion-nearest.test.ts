import assert from "node:assert/strict";
import test from "node:test";

import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildCartPromotionView, withShippingMilestone } from "../../src/routes/cart-promotion-model.ts";

/**
 * Which "mua thêm" nudge the cart shows, and whether it can take the shopper to the products that
 * reach it. Only the nearest unreached milestone is drawn; the checkout banner's listing
 * (`/offers/eligible`) only exists for campaigns the server proved to be live upsell opportunities.
 */

type GiftMilestone = Readonly<{ id: string; shortfall: number; minimum: number }>;
type TierMilestone = Readonly<{ id: string; shortfall: number; threshold: number }>;

function state({ gifts = [], tiers = [] }: Readonly<{ gifts?: readonly GiftMilestone[]; tiers?: readonly TierMilestone[] }>): CartGiftState {
  return {
    quote: {
      benefits: {
        enabled: true,
        ok: true,
        groups: [],
        campaignNames: new Map<string, string>(),
        orderValueProgress: [],
        quantityProgress: tiers.map((tier) => ({
          campaignId: tier.id,
          discountedUnits: "ALL_UNITS",
          reachedThresholdQuantity: 0,
          next: { unit: "PERCENTAGE", value: 10, shortfallQuantity: tier.shortfall, thresholdQuantity: tier.threshold },
        })),
      },
    },
    entitlements: gifts.map((gift) => ({ campaignId: gift.id, entitled: 0, shortfallToNext: { quantity: gift.shortfall } })),
    campaigns: gifts.map((gift) => ({ id: gift.id, trigger: "QUANTITY", minimumQuantity: gift.minimum, options: [], allowDuplicateGifts: true })),
    selections: [],
    labels: [],
  } as unknown as CartGiftState;
}

function nudge(view: ReturnType<typeof buildCartPromotionView>) {
  const progress = view?.items.filter((item) => item.state === "progress") ?? [];
  assert.ok(progress.length <= 1, "only the nearest milestone is drawn");
  return progress[0] ?? null;
}

test("the milestone furthest along its bar is the one shown", () => {
  const view = buildCartPromotionView(state({ gifts: [{ id: "gift-3", shortfall: 2, minimum: 3 }], tiers: [{ id: "tier-5", shortfall: 1, threshold: 5 }] }));
  assert.equal(nudge(view)?.id, "quantity-next-tier-5", "4 of 5 beats 1 of 3");
});

test("two bars equally far along are split by the fewer pieces, whatever order they were read in", () => {
  // Both are 50% of the way: one more piece of a 2-piece gift, two more of a 4-piece tier.
  const gifts = [{ id: "gift-2", shortfall: 1, minimum: 2 }] as const;
  const tiers = [{ id: "tier-4", shortfall: 2, threshold: 4 }] as const;
  assert.equal(nudge(buildCartPromotionView(state({ gifts, tiers })))?.id, "gift-next-gift-2");
  assert.equal(nudge(buildCartPromotionView(state({ gifts: [], tiers: [...tiers] })))?.id, "quantity-next-tier-4");
});

test("no confirmed opportunities means no listing link on any nudge", () => {
  const view = buildCartPromotionView(state({ gifts: [{ id: "gift-3", shortfall: 1, minimum: 3 }] }));
  assert.equal(nudge(view)?.offersHref, undefined);
  assert.equal(nudge(buildCartPromotionView(state({ gifts: [{ id: "gift-3", shortfall: 1, minimum: 3 }] }), undefined, new Set()))?.offersHref, undefined);
});

test("a confirmed opportunity links to its eligible-products listing", () => {
  const view = buildCartPromotionView(
    state({ gifts: [{ id: "gift-3", shortfall: 1, minimum: 3 }] }),
    undefined,
    new Set(["gift-3"]),
  );
  assert.equal(nudge(view)?.offersHref, "/offers/eligible?campaign=gift-3");
});

test("only the nudge that is shown carries a link, and only when its own campaign was confirmed", () => {
  const input = state({ gifts: [{ id: "gift-3", shortfall: 1, minimum: 3 }], tiers: [{ id: "tier-5", shortfall: 1, threshold: 5 }] });
  // 4 of 5 is further along than 2 of 3, so the tier is shown; the confirmed gift is not, so no link appears.
  const shown = nudge(buildCartPromotionView(input, undefined, new Set(["gift-3"])));
  assert.equal(shown?.id, "quantity-next-tier-5");
  assert.equal(shown?.offersHref, undefined);
  assert.equal(nudge(buildCartPromotionView(input, undefined, new Set(["tier-5"])))?.offersHref, "/offers/eligible?campaign=tier-5");
});

/* ------------------------------------------------------------- free shipping joins the same race */

const shipping = { name: "Freeship", minimumQuantity: 2, qualifyingQuantity: 1, shortfallQuantity: 1, listingHref: "/set-do" } as const;

test("a cart with no gift or tier promotion still gets the free-shipping nudge, linked to what counts", () => {
  const shown = nudge(withShippingMilestone(null, shipping));
  assert.equal(shown?.kind, "SHIPPING");
  assert.equal(shown?.title, "Mua thêm 1 sản phẩm áp dụng để được miễn phí vận chuyển");
  assert.equal(shown?.progress?.percent, 50);
  assert.equal(shown?.offersHref, "/set-do");
});

test("no milestone leaves the banner exactly as it was", () => {
  const banner = buildCartPromotionView(state({ gifts: [{ id: "gift-3", shortfall: 2, minimum: 3 }] }));
  assert.equal(withShippingMilestone(banner, null), banner);
  assert.equal(withShippingMilestone(null, null), null);
});

test("free shipping one piece away beats a gift two pieces away: nearest first", () => {
  const banner = buildCartPromotionView(state({ gifts: [{ id: "gift-3", shortfall: 2, minimum: 3 }] }));
  assert.equal(nudge(withShippingMilestone(banner, shipping))?.kind, "SHIPPING");
});

test("a nearer gift keeps the one bar, and free shipping does not add a second", () => {
  const banner = buildCartPromotionView(state({ gifts: [{ id: "gift-5", shortfall: 1, minimum: 5 }] }));
  const shown = nudge(withShippingMilestone(banner, { ...shipping, minimumQuantity: 4, shortfallQuantity: 3 }));
  assert.equal(shown?.id, "gift-next-gift-5");
});

test("a tie keeps the bar already chosen", () => {
  const banner = buildCartPromotionView(state({ gifts: [{ id: "gift-2", shortfall: 1, minimum: 2 }] }));
  assert.equal(nudge(withShippingMilestone(banner, shipping))?.id, "gift-next-gift-2");
});

test("reached gift conditions stay on screen beside the shipping bar", () => {
  const reached = {
    ...state({}),
    entitlements: [{ campaignId: "gift-1", entitled: 1, shortfallToNext: null }],
    campaigns: [{ id: "gift-1", trigger: "QUANTITY", minimumQuantity: 1, options: [], allowDuplicateGifts: true }],
  } as unknown as CartGiftState;
  const merged = withShippingMilestone(buildCartPromotionView(reached), shipping);
  assert.deepEqual(merged?.items.map((item) => item.state), ["achieved", "progress"]);
});
