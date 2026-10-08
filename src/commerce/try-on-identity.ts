import type { TryOnIdentity } from "./try-on-rate-limit.ts";

/**
 * Who is asking, in the two senses the try-on endpoints need. The production wiring supplies the
 * session lookup and the client-address derivation; everything decided here is pure, so the policy
 * is tested through the same code that runs in production rather than a stand-in.
 *
 * The two resolvers differ on purpose, and the difference is the whole point of this file:
 *
 * - `forAttempt` (POST) meters cost. A session lookup that fails (database down, malformed cookie)
 *   falls back to guest, never to member, so a fault can only make the limit stricter.
 * - `forDisplay` (GET quota) tells a shopper what they are allowed. Guessing "guest" for someone who
 *   is signed in would show them the wrong allowance and an offer to sign up for what they already
 *   have, so a failed lookup is not an answer: it is thrown, and the endpoint reports "unknown".
 */

/** Account ids are short opaque strings; anything else is not trusted as a rate-limit key. */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type TryOnIdentityDependencies = Readonly<{
  /** The signed-in account's id, or `null`/`undefined` when there is no session. Rejects when the lookup itself fails. */
  getSessionUserId: (headers: Headers) => Promise<string | null | undefined>;
  /** The pseudonymous client key from the trusted proxy headers; `null` when none can be derived. */
  deriveClientKey: (headers: Headers) => string | null;
}>;

export function createTryOnIdentityResolvers({ getSessionUserId, deriveClientKey }: TryOnIdentityDependencies) {
  function guest(headers: Headers): TryOnIdentity | null {
    const key = deriveClientKey(headers);
    return key === null ? null : { kind: "guest", key };
  }

  /** Any account counts — the quota is about cost, not about who the account is. */
  async function forAttempt(headers: Headers): Promise<TryOnIdentity | null> {
    try {
      const id = await getSessionUserId(headers);
      if (typeof id === "string" && MEMBER_ID_PATTERN.test(id)) return { kind: "member", key: id };
    } catch {
      // Fall through to guest.
    }
    return guest(headers);
  }

  /**
   * Throws when the session lookup fails; returns `null` when there is a session whose id cannot be
   * used as a key, or no identity can be derived at all. Neither is ever shown as a guest.
   */
  async function forDisplay(headers: Headers): Promise<TryOnIdentity | null> {
    const id = await getSessionUserId(headers);
    if (id !== null && id !== undefined) {
      return typeof id === "string" && MEMBER_ID_PATTERN.test(id) ? { kind: "member", key: id } : null;
    }
    return guest(headers);
  }

  return { forAttempt, forDisplay };
}
