/**
 * The in-transaction commerce authority for one cart line.
 *
 * Every accepted cart write — the PDP increment, an absolute quantity update, a removal's departing
 * facts — resolves through here, inside the transaction that commits it. That placement is the
 * contract: a rendered price, a `canSetQuantity` pre-check or any other fact read before the cart
 * row was locked is advice, and a catalog, stock, campaign or price change between then and now is
 * caught before the write rather than after.
 *
 * It resolves through the same `getLines` projection the cart page and checkout render use, so
 * there is exactly one answer to "what is this line, right now": one identity, one price from the
 * central promotion authority, one availability rule. A second in-mutation resolver written to be
 * "just for analytics" is how a shopper ends up charged one price and measured at another.
 *
 * The two outputs are deliberately independent:
 *
 *   - `available` is commerce authority and decides whether the write is accepted;
 *   - `snapshot` carries the bounded non-PII facts a caller may report, and never rejects a
 *     mutation. Tracking fails closed; commerce does not fail with it.
 *
 * The snapshot separates the committed unit price from the canonical item on purpose. They fail
 * independently: a line whose mirrored name is blank is perfectly purchasable and has a perfectly
 * good server price, but cannot name a vendor item. Collapsing them would make the richer contract's
 * failure silence a destination that only ever needed the money.
 */

import type { Prisma } from "../generated/prisma/client.ts";
import type { CommerceVariantItemFacts } from "../tracking/commerce-events.ts";
import type { CartLineAuthorityResolver } from "./anonymous-cart.ts";
import {
  buildCartAnalyticsItemFacts,
  toCartAnalyticsLineFacts,
} from "./cart-analytics-facts.ts";
import {
  createStorefrontCartRepository,
  type StorefrontCartReadClient,
} from "./storefront-cart-repository.ts";

/** What an accepted mutation may report, with each fact failing closed on its own. */
export type CommittedCartLineFacts = Readonly<{
  /**
   * The unit price the mutation accepted, when it is usable money. Available to a destination that
   * needs only a value even where the canonical item cannot be built.
   */
  unitPriceVnd: number | null;
  /** The complete canonical item, or `null` when one cannot be produced safely. */
  analyticsItem: CommerceVariantItemFacts | null;
  /** Existing Meta identity, captured by the same locked resolver as the price. */
  metaContentId?: string | null;
  metaContentName?: string | null;
}>;

const NO_COMMITTED_FACTS: CommittedCartLineFacts = Object.freeze({
  unitPriceVnd: null,
  analyticsItem: null,
});

function committedUnitPriceVnd(price: number | null): number | null {
  return price !== null && Number.isSafeInteger(price) && price >= 0 ? price : null;
}

/**
 * Builds the resolver a cart mutation runs under its own lock.
 *
 * `now` is fixed by the caller for the whole request so the price a mutation validates and the
 * price it snapshots are resolved against one instant, even if a campaign boundary falls in the
 * middle of the transaction.
 */
export function createCartLineAuthorityResolver({
  shopId,
  now,
}: Readonly<{
  shopId: number;
  now: Date;
}>): CartLineAuthorityResolver<CommittedCartLineFacts> {
  return async (tx: Prisma.TransactionClient, { variantId, quantity }) => {
    const repository = createStorefrontCartRepository(
      tx as unknown as StorefrontCartReadClient,
    );

    let line;
    try {
      const [resolved] = await repository.getLines({
        shopId,
        items: [{ variantId, quantity }],
        now,
      });
      line = resolved;
    } catch {
      // Malformed mirrored facts (an unusable warehouse quantity, an out-of-range shop id) mean the
      // line cannot be authorized. Failing closed here refuses the write rather than committing
      // against facts the projection itself refused to produce.
      return { available: false, snapshot: NO_COMMITTED_FACTS };
    }

    if (line === undefined) {
      return { available: false, snapshot: NO_COMMITTED_FACTS };
    }

    return {
      available: line.available,
      snapshot: Object.freeze({
        unitPriceVnd: committedUnitPriceVnd(line.price),
        metaContentId: line.productSlug,
        metaContentName: line.productName,
        analyticsItem: buildCartAnalyticsItemFacts({
          line: toCartAnalyticsLineFacts(line),
          quantity,
        }),
      }),
    };
  };
}
