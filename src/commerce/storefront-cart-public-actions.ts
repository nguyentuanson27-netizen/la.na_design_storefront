/**
 * The public boundary of the cart editor's absolute update and removal.
 *
 * The cart keeps absolute-set quantity semantics — a shopper types "3" and gets three — but the
 * *analytics* meaning of that write is a delta, and the delta is decided here from server facts
 * only: the quantity committed under the cart lock and the quantity that line held before it, both
 * read inside the same transaction.
 *
 * Which direction the delta went picks the event, and the delta itself is its quantity:
 *
 *   - committed above previous → `add_to_cart` for the difference;
 *   - committed below previous → `remove_from_cart` for the difference;
 *   - unchanged → no quantity event at all, because nothing moved.
 *
 * The browser is given the finished item facts with that quantity already applied, so no client
 * arithmetic — and no rendered price, name or quantity — can enter the event. When a safe snapshot
 * cannot be produced, the mutation still succeeded and the response says only that: tracking fails
 * closed, with nothing to fall back to.
 *
 * Outward, the response is deliberately narrow. No cart identity, no internal `VariantMirror.id`,
 * no resolved line object, no failure internals.
 */

import type { CommerceVariantItemFacts } from "../tracking/commerce-events.ts";
import { toPublicCartAnalyticsItemFacts } from "./cart-analytics-facts.ts";
import { buildCommittedMetaAddToCart } from "./meta-pixel-parameters.ts";
import type { CommittedMetaEvent } from "./meta-event-reporting.ts";

const MAX_VARIANT_ID_LENGTH = 128;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

type StorefrontCartLineStatus = {
  variantId: string;
  available: boolean;
};

type CartMutationResult = { ok: true; [key: string]: unknown } | { ok: false; [key: string]: unknown };

type StorefrontCartPublicActionDependencies = {
  getLines(): Promise<readonly StorefrontCartLineStatus[]>;
  canSetQuantity(input: { variantId: string; quantity: number }): Promise<boolean>;
  setQuantity(input: { variantId: string; quantity: number }): Promise<CartMutationResult>;
  remove(input: { variantId: string }): Promise<CartMutationResult>;
};

/** The canonical quantity event a committed cart mutation produced, if it produced one. */
export type CartMutationAnalytics = Readonly<{
  event: "add_to_cart" | "remove_from_cart";
  item: CommerceVariantItemFacts;
}>;

export type StorefrontCartUpdateResult =
  | Readonly<{
      ok: true;
      /** Absent only if a committed write could not state both ends of its own transition. */
      transition?: Readonly<{ previousQuantity: number; quantity: number }>;
      analytics?: CartMutationAnalytics;
      analyticsUnavailable?: true;
      metaEvent?: CommittedMetaEvent;
    }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "LINE_UNAVAILABLE" | "UPDATE_FAILED" }>;

export type StorefrontCartRemoveResult
  = | Readonly<{
      ok: true;
      removedQuantity: number;
      analytics?: CartMutationAnalytics;
      analyticsUnavailable?: true;
    }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "LINE_UNAVAILABLE" | "REMOVE_FAILED" }>;

function parseVariantId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VARIANT_ID_LENGTH ||
    value !== value.trim()
  ) {
    return null;
  }
  return value;
}

function parseUpdateInput(input: unknown): { variantId: string; quantity: number } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const variantId = parseVariantId(record.variantId);
  const quantity = record.quantity;
  if (
    !variantId ||
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_POSTGRES_INTEGER
  ) {
    return null;
  }
  return { variantId, quantity };
}

function parseRemoveInput(input: unknown): { variantId: string } | null {
  if (!input || typeof input !== "object") return null;
  const variantId = parseVariantId((input as Record<string, unknown>).variantId);
  return variantId ? { variantId } : null;
}

function readCommittedQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The canonical item out of a committed-facts snapshot.
 *
 * The snapshot also carries the committed unit price on its own, for destinations that need only a
 * value; the cart editor has no such destination, so it reads the item and nothing else.
 */
function readSnapshotItem(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return (value as Record<string, unknown>).analyticsItem;
}

export function createStorefrontCartPublicActions({
  getLines,
  canSetQuantity,
  setQuantity,
  remove,
}: StorefrontCartPublicActionDependencies) {
  async function update(input: unknown): Promise<StorefrontCartUpdateResult> {
    const parsed = parseUpdateInput(input);
    if (!parsed) return { ok: false, reason: "INVALID_INPUT" };

    const line = (await getLines()).find(({ variantId }) => variantId === parsed.variantId);
    if (!line) {
      return { ok: false, reason: "LINE_UNAVAILABLE" };
    }

    if (!(await canSetQuantity(parsed))) {
      return { ok: false, reason: "LINE_UNAVAILABLE" };
    }

    const result = await setQuantity(parsed);
    if (!result.ok) {
      // `VARIANT_UNAVAILABLE` here means the in-transaction re-resolution refused the requested
      // quantity after the advisory pre-check allowed it — the shopper's line is genuinely no
      // longer settable, so it reads as unavailable rather than as an internal failure.
      return result.reason === "VARIANT_UNAVAILABLE"
        ? { ok: false, reason: "LINE_UNAVAILABLE" }
        : { ok: false, reason: "UPDATE_FAILED" };
    }

    const previousQuantity = readCommittedQuantity(result.previousQuantity);
    const quantity = readCommittedQuantity(
      (result.item as { quantity?: unknown } | undefined)?.quantity,
    );
    if (previousQuantity === null || quantity === null) {
      // The write committed, so this is a success. Without both endpoints of the transition there
      // is no honest delta to report and no transition to state; a placeholder pair would read as
      // a real "nothing moved" result, which is a different claim.
      return Object.freeze({ ok: true as const, analyticsUnavailable: true as const });
    }

    const transition = Object.freeze({ previousQuantity, quantity });
    if (quantity === previousQuantity) {
      // Nothing moved. An absolute update that lands on the current quantity is a successful write
      // and not a cart quantity event.
      return Object.freeze({ ok: true as const, transition });
    }

    const delta = quantity > previousQuantity
      ? quantity - previousQuantity
      : previousQuantity - quantity;
    const item = toPublicCartAnalyticsItemFacts(readSnapshotItem(result.snapshot), delta);
    const metaEvent = quantity > previousQuantity ? buildCommittedMetaAddToCart(result.snapshot, delta) : undefined;
    const metaFacts = metaEvent ? { metaEvent } : {};

    return item === null
      ? Object.freeze({ ok: true as const, transition, ...metaFacts, analyticsUnavailable: true as const })
      : Object.freeze({
          ok: true as const,
          transition,
          ...metaFacts,
          analytics: Object.freeze({
            event: quantity > previousQuantity
              ? ("add_to_cart" as const)
              : ("remove_from_cart" as const),
            item,
          }),
        });
  }

  async function removeLine(input: unknown): Promise<StorefrontCartRemoveResult> {
    const parsed = parseRemoveInput(input);
    if (!parsed) return { ok: false, reason: "INVALID_INPUT" };

    const line = (await getLines()).find(({ variantId }) => variantId === parsed.variantId);
    if (!line) {
      return { ok: false, reason: "LINE_UNAVAILABLE" };
    }

    const result = await remove(parsed);
    if (!result.ok) {
      return { ok: false, reason: "REMOVE_FAILED" };
    }

    const removedQuantity = readCommittedQuantity(result.removedQuantity);
    // Zero means the line was already gone by the time the cart row was locked. The request
    // succeeded, but nothing left the cart, so there is no RemoveFromCart to report.
    if (removedQuantity === null || removedQuantity === 0) {
      return Object.freeze({ ok: true as const, removedQuantity: removedQuantity ?? 0 });
    }

    const item = toPublicCartAnalyticsItemFacts(readSnapshotItem(result.snapshot), removedQuantity);
    return item === null
      ? Object.freeze({ ok: true as const, removedQuantity, analyticsUnavailable: true as const })
      : Object.freeze({
          ok: true as const,
          removedQuantity,
          analytics: Object.freeze({ event: "remove_from_cart" as const, item }),
        });
  }

  return { update, remove: removeLine };
}
