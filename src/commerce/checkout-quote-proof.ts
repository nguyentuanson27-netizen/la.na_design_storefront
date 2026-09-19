/**
 * The rendered-quote proof: what the buyer was shown, provable by the server alone.
 *
 * P8 persists the *current* authoritative quote. That is not the same as proving the buyer agreed
 * to it — a campaign that ends between render and submission is silently re-resolved upward, and
 * the buyer is charged a number they never saw. This module is the missing half: checkout render
 * issues an opaque token over the exact quote facts it rendered, and submission refuses to create a
 * submit-capable DRAFT unless that token still describes the current quote.
 *
 * Three properties do the work, and each one is a deliberate refusal of an easier design.
 *
 * **It is stateless.** A standard-library HMAC over canonical bytes, no proof rows, no nonce table,
 * no append-only issuance log. Server-held proof state would need issuing, expiring and garbage
 * collecting, and every one of those is a way for a buyer to be locked out of their own checkout by
 * a table nobody is watching.
 *
 * **The cart identity is MAC context, never payload.** The raw anonymous-cart UUID lives in an
 * HttpOnly cookie precisely so a browser cannot read it. Serializing it into a token the browser
 * holds would hand it back, so it is mixed into the MAC input and never into the payload bytes. The
 * token still cannot be replayed against another cart, because a different cart produces a
 * different MAC over the same payload.
 *
 * **It never becomes price authority.** Verification answers exactly one question — does this token
 * describe the quote the server has independently recomputed? — and its `ok` says nothing about
 * what to charge. A caller that read money out of a token would have handed pricing to the browser,
 * which is the whole failure this exists to prevent, so no money is returned from here at all.
 *
 * Canonicalization is byte-exact and self-delimiting: every variant id is length-prefixed, so an id
 * containing the field separators cannot be arranged to canonicalize as a different quote. Because
 * the encoding is deterministic, staleness is decided by comparing canonical bytes rather than by
 * parsing the payload back into numbers — there is no parser here to get wrong, and no path by
 * which token bytes turn into a price.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The accepted proof envelope.
 *
 * Verification rejects anything larger before decoding, so issuing must respect the same bound:
 * `variantExternalId` is a mirrored Pancake value that nothing in this repository length-bounds —
 * `VariantMirror.pancakeVariationId` is an unbounded column and the catalog contract only requires
 * non-empty — so a long enough synced id could otherwise make checkout hand out a token its own
 * verifier always refuses, leaving the buyer in a reconfirm loop no retry can escape. Issuing
 * therefore refuses to produce a token it could not verify, and the caller fails closed instead.
 */
export const MAX_RENDERED_QUOTE_PROOF_BYTES = 16 * 1024;

// Bumped for F8b: the canonical bytes now carry each line's fulfillment state, so a proof issued
// under the old format no longer describes the same facts. An in-flight checkout gets one
// re-confirmation rather than silently redeeming a token that said nothing about waiting.
const PROOF_FORMAT = "laq2";
const PROOF_KEY_CONTEXT = "la-clothing:checkout-quote-proof-key:v1";
const MIN_SECRET_LENGTH = 32;
const MAC_BYTES = 32;
const PROOF_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The bounded non-PII facts a rendered quote is made of. Structurally identical to
 * `RenderedCheckoutQuoteFacts`, restated here so this module owes nothing to the checkout render
 * and can be handed the same shape rebuilt from persisted order lines.
 */
export type RenderedQuoteProofFacts = Readonly<{
  items: readonly Readonly<{
    variantExternalId: string;
    quantity: number;
    unitPriceVnd: number;
    /**
     * Master spec §30 — whether this line was presented as waiting for preparation.
     *
     * Authenticated with the money, because it is part of what the buyer acknowledged. Without it
     * capacity could move between render and reservation and the order could be accepted under a
     * fulfillment state the buyer never saw: a checkout that read as ready stock, committed as
     * `PREORDER`, and snapshotted that way into immutable history.
     */
    fulfillmentState: "READY" | "PREORDER";
  }>[];
  merchandiseSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  totalQuantity: number;
}>;

export type RenderedQuoteProofRejection =
  /** No proof was presented at all. */
  | "PROOF_MISSING"
  /** Longer than the accepted envelope; rejected before any decode or MAC work. */
  | "PROOF_OVERSIZED"
  /** Not the `<payload>.<mac>` base64url shape, or the MAC is the wrong width. */
  | "PROOF_MALFORMED"
  /** Authentic-looking but not signed by this server for this cart. */
  | "PROOF_UNVERIFIED"
  /** Genuinely ours, but it describes a quote that is no longer current. */
  | "PRICE_CHANGED";

export type RenderedQuoteProofVerification =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: RenderedQuoteProofRejection }>;

/**
 * The same bound the order snapshot calls supported money (`isSupportedVndAmount`), deliberately
 * matching rather than tightening it. This module attests what a quote *said*; deciding that some
 * amount is not sellable belongs to the pricing authority. Requiring more here than the code that
 * produces these facts would mean a quote the snapshot happily persists could not be proven, which
 * is a disagreement between two modules about the same numbers.
 */
function isUsableVnd(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function areUsableFacts(quote: RenderedQuoteProofFacts): boolean {
  if (
    !quote ||
    !Array.isArray(quote.items) ||
    quote.items.length === 0 ||
    !isUsableVnd(quote.merchandiseSubtotalVnd) ||
    !isUsableVnd(quote.shippingFeeVnd) ||
    !isUsableVnd(quote.totalVnd) ||
    !Number.isSafeInteger(quote.totalQuantity) ||
    quote.totalQuantity <= 0
  ) {
    return false;
  }

  const seen = new Set<string>();
  for (const item of quote.items) {
    if (
      typeof item?.variantExternalId !== "string" ||
      item.variantExternalId.length === 0 ||
      seen.has(item.variantExternalId) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !isUsableVnd(item.unitPriceVnd) ||
      (item.fulfillmentState !== "READY" && item.fulfillmentState !== "PREORDER")
    ) {
      return false;
    }
    seen.add(item.variantExternalId);
  }
  return true;
}

function requireUsableFacts(quote: RenderedQuoteProofFacts): void {
  if (!areUsableFacts(quote)) {
    throw new TypeError("Rendered quote proof facts must be bounded website money");
  }
}

/**
 * Deterministic, self-delimiting canonical bytes.
 *
 * Items are sorted here rather than trusted from the caller, so the render path and the order
 * snapshot — which walk their lines in different orders — canonicalize identically. Each id is
 * prefixed with its byte length, which is what makes an id containing `|` or `:` unable to
 * masquerade as extra fields.
 */
function canonicalQuoteBytes(quote: RenderedQuoteProofFacts): Buffer {
  const items = [...quote.items].sort((left, right) =>
    left.variantExternalId < right.variantExternalId
      ? -1
      : left.variantExternalId > right.variantExternalId
        ? 1
        : 0,
  );

  let canonical =
    `${PROOF_FORMAT}` +
    `|${quote.totalQuantity}` +
    `|${quote.merchandiseSubtotalVnd}` +
    `|${quote.shippingFeeVnd}` +
    `|${quote.totalVnd}` +
    `|${items.length}`;

  for (const item of items) {
    const idBytes = Buffer.byteLength(item.variantExternalId, "utf8");
    canonical += `|${idBytes}:${item.variantExternalId}:${item.quantity}:${item.unitPriceVnd}:${item.fulfillmentState}`;
  }

  return Buffer.from(canonical, "utf8");
}

/**
 * A key used for nothing else.
 *
 * Derived from the already-validated server secret through a context string, so a proof can never
 * be made to verify as a session token or a client-identity digest and vice versa. Follows the same
 * shape as `deriveGuestCheckoutClientKey`; the context string is what keeps the two apart.
 */
function deriveProofKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new TypeError("Rendered quote proof requires the validated server secret");
  }
  return createHmac("sha256", secret).update(PROOF_KEY_CONTEXT).digest();
}

function isUsableCartId(cartId: string): boolean {
  return typeof cartId === "string" && cartId.length > 0;
}

function requireCartId(cartId: string): string {
  if (!isUsableCartId(cartId)) {
    throw new TypeError("Rendered quote proof requires a server-read cart identity");
  }
  return cartId;
}

/**
 * The cart id enters here and only here. It is length-prefixed for the same reason variant ids are:
 * without it, a cart id ending in a separator could shift the payload boundary.
 */
function computeMac(key: Buffer, cartId: string, payload: Buffer): Buffer {
  const cartBytes = Buffer.from(cartId, "utf8");
  return createHmac("sha256", key)
    .update(Buffer.from(`${cartBytes.length}:`, "utf8"))
    .update(cartBytes)
    .update(payload)
    .digest();
}

/**
 * Issues a proof, or `null` when these facts cannot produce a verifiable one.
 *
 * The two failure modes are deliberately different shapes. Facts that are not bounded website money
 * are a programming error at the call site and throw. Exceeding the envelope is a data condition the
 * caller must handle — it depends on how long an external id the catalog happens to carry — so it
 * returns `null` and the checkout render refuses to quote rather than issuing a token that could
 * never be redeemed.
 */
export function issueRenderedQuoteProof({
  quote,
  cartId,
  secret,
}: Readonly<{
  quote: RenderedQuoteProofFacts;
  cartId: string;
  secret: string;
}>): string | null {
  requireUsableFacts(quote);
  const key = deriveProofKey(secret);
  const safeCartId = requireCartId(cartId);

  const payload = canonicalQuoteBytes(quote);
  const mac = computeMac(key, safeCartId, payload);

  const proof = `${payload.toString("base64url")}.${mac.toString("base64url")}`;
  return Buffer.byteLength(proof, "utf8") > MAX_RENDERED_QUOTE_PROOF_BYTES ? null : proof;
}

/**
 * Establishes only that this token is ours, is bound to this cart, and describes `currentQuote`.
 *
 * The caller must have recomputed `currentQuote` from server-authoritative pricing before calling:
 * the token is checked *against* that answer and never contributes to it.
 */
export function verifyRenderedQuoteProof({
  proof,
  cartId,
  currentQuote,
  secret,
}: Readonly<{
  proof: unknown;
  cartId: string;
  currentQuote: RenderedQuoteProofFacts;
  secret: string;
}>): RenderedQuoteProofVerification {
  // Everything below fails closed rather than throwing. This runs inside the snapshot transaction,
  // where an exception aborts a database transaction and surfaces to the buyer as a generic outage
  // for what is really an ordinary "re-confirm the price" outcome. The one deliberate exception is
  // the server secret: a misconfigured key must be loud, because failing closed on it would turn
  // every checkout into an unexplained permanent price-change loop.
  if (!isUsableCartId(cartId)) {
    return Object.freeze({ ok: false as const, reason: "PROOF_UNVERIFIED" as const });
  }
  if (typeof proof !== "string" || proof.length === 0) {
    return Object.freeze({ ok: false as const, reason: "PROOF_MISSING" as const });
  }
  // Before any decode or MAC work, so an oversized body is never allocated or hashed.
  if (Buffer.byteLength(proof, "utf8") > MAX_RENDERED_QUOTE_PROOF_BYTES) {
    return Object.freeze({ ok: false as const, reason: "PROOF_OVERSIZED" as const });
  }
  if (!PROOF_PATTERN.test(proof)) {
    return Object.freeze({ ok: false as const, reason: "PROOF_MALFORMED" as const });
  }

  const separator = proof.indexOf(".");
  const payload = Buffer.from(proof.slice(0, separator), "base64url");
  const presentedMac = Buffer.from(proof.slice(separator + 1), "base64url");
  if (payload.length === 0 || presentedMac.length !== MAC_BYTES) {
    return Object.freeze({ ok: false as const, reason: "PROOF_MALFORMED" as const });
  }

  const key = deriveProofKey(secret);
  const expectedMac = computeMac(key, cartId, payload);
  if (!timingSafeEqual(presentedMac, expectedMac)) {
    return Object.freeze({ ok: false as const, reason: "PROOF_UNVERIFIED" as const });
  }

  // Authentic and bound to this cart. Only now does staleness become a meaningful question: the
  // comparison is byte equality against the canonicalization of what the server just computed, so
  // no value from the token is ever read back out as a fact.
  if (!areUsableFacts(currentQuote)) {
    return Object.freeze({ ok: false as const, reason: "PRICE_CHANGED" as const });
  }
  if (!payload.equals(canonicalQuoteBytes(currentQuote))) {
    return Object.freeze({ ok: false as const, reason: "PRICE_CHANGED" as const });
  }

  return Object.freeze({ ok: true as const });
}
