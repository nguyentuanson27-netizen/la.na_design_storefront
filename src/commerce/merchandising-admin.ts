/**
 * M2 / M3a / M3b — the admin authorization boundary for website-owned merchandising.
 *
 * ADR 0013 §4.6 requires every merchandising write to sit behind `requireAdminSession`, and §4.5
 * requires the membership write in particular to be the *only* path that can produce a membership
 * row, because it is the only place the one-top-level invariant is enforced. This service is that
 * boundary: the repository below it is not a public surface, and nothing but this may call it from
 * a request.
 *
 * Whatever an admin page renders is a convenience. Nothing here trusts it — the browser can submit
 * anything, and the parsers in `merchandising-input.ts` and `category-taxonomy.ts` decide what the
 * database is allowed to hold.
 *
 * Every operation is all-or-nothing and reports a reason rather than throwing at the caller: a
 * partially applied merchandising decision is worse than a rejected one, because the operator has no
 * way to tell which half took effect.
 */

import { requireAdminSession } from "../auth/authorization.ts";
import { CategoryMembershipError } from "./category-taxonomy.ts";
import { MerchandisingError, type MerchandisingErrorReason } from "./merchandising-input.ts";

type AdminSessionCandidate =
  | {
      user: {
        id: string;
        role?: string | null;
      };
      session: {
        id: string;
      };
    }
  | null
  | undefined;

export type MerchandisingAdminResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

type MerchandisingWriter = {
  replaceHomepageFeatured(input: { shopId: number; productIds: unknown }): Promise<unknown>;
  replaceCategoryMembership(input: {
    shopId: number;
    productId: string;
    categoryKeys: unknown;
  }): Promise<unknown>;
  replaceCategoryProductOrder(input: { shopId: number; input: unknown }): Promise<unknown>;
  replaceRelatedProductOverrides(input: { shopId: number; input: unknown }): Promise<unknown>;
  saveCategoryEditorialMedia(input: unknown): Promise<unknown>;
};

/**
 * Turns the two validation error families into a reason code, and lets everything else through.
 *
 * A `MerchandisingError` or `CategoryMembershipError` means the submission was rejected, which the
 * operator needs to see. Anything else — a lost connection, a constraint nobody anticipated — is a
 * fault, not a verdict on the input, and must keep propagating rather than being reported to the
 * admin as "your submission was invalid".
 */
async function attempt(run: () => Promise<unknown>): Promise<MerchandisingAdminResult> {
  try {
    await run();
    return { ok: true } as const;
  } catch (error) {
    if (error instanceof MerchandisingError || error instanceof CategoryMembershipError) {
      return { ok: false, reason: error.reason } as const;
    }
    throw error;
  }
}

const INVALID_PRODUCT: MerchandisingErrorReason = "merchandising-invalid-product";

function parseProductId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const productId = value.trim();
  return productId.length === 0 || productId.length > 64 ? null : productId;
}

export function createMerchandisingAdminService({
  shopId,
  repository,
}: {
  shopId: number;
  repository: MerchandisingWriter;
}) {
  /** ADR §3 — replace the homepage Featured selection. An empty list empties the section. */
  async function replaceHomepageFeatured(
    session: AdminSessionCandidate,
    productIds: unknown,
  ): Promise<MerchandisingAdminResult> {
    requireAdminSession(session);
    return attempt(() => repository.replaceHomepageFeatured({ shopId, productIds }));
  }

  /**
   * ADR §4.6 — replace one product's category assignment.
   *
   * Full replacement, never incremental: an add/remove path could leave a product observably
   * spanning two trees between the two writes, which is the exact state the invariant forbids.
   */
  async function replaceCategoryMembership(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<MerchandisingAdminResult> {
    requireAdminSession(session);

    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const productId = parseProductId(record.productId);
    if (productId === null) return { ok: false, reason: INVALID_PRODUCT } as const;

    return attempt(() =>
      repository.replaceCategoryMembership({ shopId, productId, categoryKeys: record.categoryKeys }),
    );
  }

  /** ADR §5 — replace one category's manual PLP ranking. */
  async function replaceCategoryProductOrder(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<MerchandisingAdminResult> {
    requireAdminSession(session);
    return attempt(() => repository.replaceCategoryProductOrder({ shopId, input }));
  }

  /** ADR §7 stage 1 — replace one product's manual related picks. */
  async function replaceRelatedProductOverrides(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<MerchandisingAdminResult> {
    requireAdminSession(session);
    return attempt(() => repository.replaceRelatedProductOverrides({ shopId, input }));
  }

  /** ADR §6 — set or clear a category's editorial and mega-menu media. */
  async function saveCategoryEditorialMedia(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<MerchandisingAdminResult> {
    requireAdminSession(session);
    return attempt(() => repository.saveCategoryEditorialMedia(input));
  }

  return {
    replaceHomepageFeatured,
    replaceCategoryMembership,
    replaceCategoryProductOrder,
    replaceRelatedProductOverrides,
    saveCategoryEditorialMedia,
  };
}
