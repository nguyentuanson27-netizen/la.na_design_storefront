/**
 * I2 — the admin authorization boundary for selling policy (ADR 0014 §5, §11).
 *
 * Same shape as `merchandising-admin.ts`, deliberately: `requireAdminSession` first, the repository
 * below is not a public surface, and nothing but this may call it from a request. Two services with
 * two conventions is how one of them ends up without the session check.
 *
 * What an admin page renders is a convenience. Nothing here trusts it — the browser can post
 * anything, and `capacity-policy-input.ts` decides what the database is allowed to hold.
 *
 * The UI is I3 and the cart/checkout enforcement is I5. What this unlocks today is the *value*: with
 * a policy row in the table, I4's `resolveVariantSellability()` stops resolving every product to
 * `STANDARD`, and the storefront starts honouring the owner's allowance.
 */

import { requireAdminSession } from "../auth/authorization.ts";
import type { ResolvedSellingPolicy } from "./capacity-policy.ts";
import {
  parseSellingPolicySubmission,
  SellingPolicyError,
  type SellingPolicyErrorReason,
} from "./capacity-policy-input.ts";

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

export type SellingPolicyAdminResult =
  | Readonly<{ ok: true; policy: ResolvedSellingPolicy }>
  | Readonly<{ ok: false; reason: SellingPolicyErrorReason }>;

type SellingPolicyWriter = {
  saveSellingPolicy(input: {
    shopId: number;
    productId: string;
    sellingMode: ResolvedSellingPolicy["sellingMode"];
    negativeStockLimit: number;
  }): Promise<ResolvedSellingPolicy>;
  clearSellingPolicy(input: { shopId: number; productId: string }): Promise<ResolvedSellingPolicy>;
};

/**
 * Turns a `SellingPolicyError` into a reason code, and lets everything else through.
 *
 * A `SellingPolicyError` is a verdict on the submission, which the operator needs to see. A lost
 * connection or an unanticipated constraint is a fault, not a verdict, and must keep propagating
 * rather than being reported to the admin as "your submission was invalid" — the same division
 * `merchandising-admin.ts` draws, for the same reason.
 */
async function attempt(
  run: () => Promise<ResolvedSellingPolicy>,
): Promise<SellingPolicyAdminResult> {
  try {
    return { ok: true, policy: await run() } as const;
  } catch (error) {
    if (error instanceof SellingPolicyError) {
      return { ok: false, reason: error.reason } as const;
    }
    throw error;
  }
}

export function createSellingPolicyAdminService({
  shopId,
  repository,
}: {
  shopId: number;
  repository: SellingPolicyWriter;
}) {
  /**
   * §5 — set one product's mode and negative-stock allowance.
   *
   * Parsing happens inside `attempt` rather than before it, so a rejected submission returns a
   * reason like every other refusal instead of throwing past the caller. The session check stays
   * outside: an unauthenticated caller must not learn whether their payload would have parsed.
   */
  async function saveSellingPolicy(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<SellingPolicyAdminResult> {
    requireAdminSession(session);

    return attempt(async () => {
      const submission = parseSellingPolicySubmission(input);
      return repository.saveSellingPolicy({ shopId, ...submission });
    });
  }

  /**
   * §5.1 — return a product to **unconfigured**, which is not the same as configuring it to the
   * default. The resolved policy that comes back carries `isDefault: true`, so the caller can render
   * the distinction rather than re-deriving it.
   */
  async function clearSellingPolicy(
    session: AdminSessionCandidate,
    input: unknown,
  ): Promise<SellingPolicyAdminResult> {
    requireAdminSession(session);

    return attempt(async () => {
      // Only the product id is meaningful here, so the mode is supplied rather than read from the
      // submission: a clear must not be refusable for naming no mode.
      const { productId } = parseSellingPolicySubmission({
        ...(typeof input === "object" && input !== null ? input : {}),
        sellingMode: "standard",
        negativeStockLimit: null,
      });
      return repository.clearSellingPolicy({ shopId, productId });
    });
  }

  return { saveSellingPolicy, clearSellingPolicy };
}
