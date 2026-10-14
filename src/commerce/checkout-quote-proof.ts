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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { validateQuoteStructure, type QuoteStructure } from "./order-quote-rules.ts";

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


// ---------------------------------------------------------------------------------------------------
// GQ16 -- the benefit-aware quote: proof keyed by lineId and role, and the non-claim acknowledgement.
//
// The functions above keep proving the legacy quote byte for byte (`laq2`: distinct variations, one
// price each), so a cart with no gift and no quantity tier -- and every cart while the gate is OFF --
// is unaffected. A cart that has either is proven in the format below, which signs what the money
// alone cannot say: which segments exist and at what price, what each gift is and under which
// campaign revision, how many slots were earned, taken and left, and the ordered discounts behind
// every paid price. A change to any of them is `PRICE_CHANGED` even when the total is identical
// (EX-13/14/17: a paid unit swapped for a gift of the same value must not redeem the old proof).
//
// The rules that hold for the legacy proof hold here too: stateless, the cart id is MAC context and
// never payload, verification compares canonical bytes against what the server just recomputed and
// reads nothing back out of the token, and a malformed input fails closed instead of throwing.
// ---------------------------------------------------------------------------------------------------

/** What the buyer was shown, with paid and gift segments. Identical in shape to what an order stores. */
export type BenefitQuoteProofFacts = QuoteStructure;

export const BENEFIT_PROOF_FORMAT = "laq3";

/**
 * A quote with many segments is larger than a legacy one (each line carries its role, campaign and
 * ordered discount steps), so the envelope is wider. It is still bounded, and issuing refuses to
 * produce a token the verifier would reject, so a buyer is never stuck re-confirming a quote that can
 * never be proven; the quote is simply not offered.
 */
export const MAX_BENEFIT_QUOTE_PROOF_BYTES = 48 * 1024;

function requireUsableBenefitFacts(quote: BenefitQuoteProofFacts) {
  const verdict = validateQuoteStructure(quote);
  if (!verdict.ok) throw new TypeError("Benefit quote proof facts must be a bounded, consistent website quote");
  return verdict.totals;
}

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function text(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * Deterministic, self-delimiting canonical bytes. Lines are sorted by `lineId` and entitlements by
 * campaign here rather than trusted from the caller; the ordered discount steps keep their order
 * because the order is part of what was proven. Every free-text field is length-prefixed, so a value
 * containing a separator cannot canonicalize as extra fields.
 */
function canonicalBenefitQuoteBytes(quote: BenefitQuoteProofFacts): Buffer {
  const totals = requireUsableBenefitFacts(quote);
  const lines = [...quote.lines].sort((left, right) => byText(left.lineId, right.lineId));
  const entitlements = [...quote.entitlements].sort((left, right) => byText(left.campaignId, right.campaignId));

  let canonical =
    `${BENEFIT_PROOF_FORMAT}` +
    `|${totals.paidQuantity}|${totals.giftQuantity}` +
    `|${quote.paidSubtotalVnd}|${quote.shippingFeeVnd}|${quote.totalVnd}` +
    `|${lines.length}|${entitlements.length}`;

  for (const line of lines) {
    const campaign = line.campaign === null ? "-" : `${text(line.campaign.id)}@${line.campaign.revision}`;
    canonical +=
      `|L${text(line.lineId)}:${line.role}:${text(line.pancakeVariationId)}` +
      `:${line.quantity}:${line.unitPriceVnd}:${line.lineTotalVnd}:${line.fulfillmentState}:${campaign}:${line.discountSteps.length}`;
    for (const step of line.discountSteps) {
      canonical +=
        `;${text(step.campaignId)}:${step.source}:${text(step.campaignKind)}` +
        `:${step.priority === null ? "-" : step.priority}:${step.inputPriceVnd}:${step.outputPriceVnd}:${step.appliedQuantity}`;
    }
  }
  for (const entry of entitlements) {
    canonical +=
      `|E${text(entry.campaignId)}:${entry.campaignRevision}:${entry.entitled}:${entry.selected}` +
      `:${entry.skippedWhileAvailable}:${entry.contendedForSharedStock}:${entry.shortForStock}`;
  }
  return Buffer.from(canonical, "utf8");
}

/**
 * SHA-256 (hex) of the canonical bytes: what an order snapshot stores as `quoteDigest`, and what the
 * acknowledgement binds to. It identifies a quote; it is not a secret and proves nothing by itself.
 */
export function benefitQuoteDigest(quote: BenefitQuoteProofFacts): string {
  return createHash("sha256").update(canonicalBenefitQuoteBytes(quote)).digest("hex");
}

/** FR-06: whether the buyer must explicitly acknowledge slots they are not taking before ordering. */
export function benefitQuoteNeedsNonclaimAcknowledgement(quote: BenefitQuoteProofFacts): boolean {
  return requireUsableBenefitFacts(quote).unclaimedSlots > 0;
}

/**
 * Issues a benefit-quote proof, or `null` when it would exceed the envelope (the caller then refuses
 * to offer the quote). Facts that are not a consistent bounded quote are a programming error and throw.
 */
export function issueBenefitQuoteProof({
  quote,
  cartId,
  secret,
}: Readonly<{ quote: BenefitQuoteProofFacts; cartId: string; secret: string }>): string | null {
  const payload = canonicalBenefitQuoteBytes(quote);
  const key = deriveProofKey(secret);
  const mac = computeMac(key, requireCartId(cartId), payload);
  const proof = `${payload.toString("base64url")}.${mac.toString("base64url")}`;
  return Buffer.byteLength(proof, "utf8") > MAX_BENEFIT_QUOTE_PROOF_BYTES ? null : proof;
}

/** Same single question as `verifyRenderedQuoteProof`, for a benefit quote. Never returns money. */
export function verifyBenefitQuoteProof({
  proof,
  cartId,
  currentQuote,
  secret,
}: Readonly<{ proof: unknown; cartId: string; currentQuote: BenefitQuoteProofFacts; secret: string }>): RenderedQuoteProofVerification {
  const reject = (reason: RenderedQuoteProofRejection) => Object.freeze({ ok: false as const, reason });
  if (!isUsableCartId(cartId)) return reject("PROOF_UNVERIFIED");
  if (typeof proof !== "string" || proof.length === 0) return reject("PROOF_MISSING");
  if (Buffer.byteLength(proof, "utf8") > MAX_BENEFIT_QUOTE_PROOF_BYTES) return reject("PROOF_OVERSIZED");
  if (!PROOF_PATTERN.test(proof)) return reject("PROOF_MALFORMED");

  const separator = proof.indexOf(".");
  const payload = Buffer.from(proof.slice(0, separator), "base64url");
  const presentedMac = Buffer.from(proof.slice(separator + 1), "base64url");
  if (payload.length === 0 || presentedMac.length !== MAC_BYTES) return reject("PROOF_MALFORMED");

  const key = deriveProofKey(secret);
  if (!timingSafeEqual(presentedMac, computeMac(key, cartId, payload))) return reject("PROOF_UNVERIFIED");

  // Authentic and bound to this cart. A current quote that is not itself well formed cannot match.
  if (!validateQuoteStructure(currentQuote).ok) return reject("PRICE_CHANGED");
  return payload.equals(canonicalBenefitQuoteBytes(currentQuote)) ? Object.freeze({ ok: true as const }) : reject("PRICE_CHANGED");
}

// -- Non-claim acknowledgement -------------------------------------------------------------------

const ACK_FORMAT = "laa1";
const ACK_KEY_CONTEXT = "la-clothing:checkout-quote-ack-key:v1";
const ACK_PATTERN = /^laa1\|([0-9]{1,12})\|([0-9a-f]{64})$/;
const MAX_ACK_TOKEN_BYTES = 512;
/** An acknowledgement is a consent given at a moment; after this long the buyer is asked again. */
export const MAX_NONCLAIM_ACK_AGE_SECONDS = 2 * 60 * 60;
const ACK_CLOCK_SKEW_SECONDS = 60;

export type NonclaimAcknowledgementRejection =
  | "ACK_MISSING"
  | "ACK_MALFORMED"
  | "ACK_UNVERIFIED"
  /** The quote has no unclaimed slots, so there is nothing to acknowledge; the token is ignored. */
  | "ACK_NOT_REQUIRED"
  /** Genuine, but given for a different quote: prices, gifts, slots or campaign revisions moved. */
  | "ACK_STALE"
  | "ACK_EXPIRED";

export type NonclaimAcknowledgementVerification =
  | Readonly<{ ok: true; acknowledgedAt: Date }>
  | Readonly<{ ok: false; reason: NonclaimAcknowledgementRejection }>;

/** A key used for nothing else: an acknowledgement can never verify as a quote proof or the reverse. */
function deriveAckKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new TypeError("Non-claim acknowledgement requires the validated server secret");
  }
  return createHmac("sha256", secret).update(ACK_KEY_CONTEXT).digest();
}

/**
 * Issues the buyer's explicit acknowledgement that they are not taking every gift slot they earned.
 *
 * It binds the digest of the exact quote shown, the cart (as MAC context, never payload) and the
 * moment it was given, and nothing else. Returns `null` when the quote has nothing to acknowledge, so
 * a consent to nothing is never minted. The caller must have verified the buyer's render proof first;
 * this function does not decide that the buyer saw the quote.
 */
export function issueNonclaimAcknowledgement({
  quote,
  cartId,
  secret,
  now,
}: Readonly<{ quote: BenefitQuoteProofFacts; cartId: string; secret: string; now: Date }>): string | null {
  if (!benefitQuoteNeedsNonclaimAcknowledgement(quote)) return null;
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt >= 1e12) throw new TypeError("Acknowledgement time must be a real instant");
  const payload = Buffer.from(`${ACK_FORMAT}|${issuedAt}|${benefitQuoteDigest(quote)}`, "utf8");
  const mac = computeMac(deriveAckKey(secret), requireCartId(cartId), payload);
  return `${payload.toString("base64url")}.${mac.toString("base64url")}`;
}

/**
 * Establishes that this acknowledgement is ours, belongs to this cart, was given for exactly
 * `currentQuote` and is recent enough. The instant it returns comes from the signed payload, never
 * from the browser, and is what an order records as `acknowledgedAt`.
 */
export function verifyNonclaimAcknowledgement({
  token,
  cartId,
  currentQuote,
  secret,
  now,
}: Readonly<{ token: unknown; cartId: string; currentQuote: BenefitQuoteProofFacts; secret: string; now: Date }>): NonclaimAcknowledgementVerification {
  const reject = (reason: NonclaimAcknowledgementRejection) => Object.freeze({ ok: false as const, reason });
  if (!isUsableCartId(cartId)) return reject("ACK_UNVERIFIED");
  if (typeof token !== "string" || token.length === 0) return reject("ACK_MISSING");
  if (Buffer.byteLength(token, "utf8") > MAX_ACK_TOKEN_BYTES || !PROOF_PATTERN.test(token)) return reject("ACK_MALFORMED");

  const separator = token.indexOf(".");
  const payload = Buffer.from(token.slice(0, separator), "base64url");
  const presentedMac = Buffer.from(token.slice(separator + 1), "base64url");
  if (payload.length === 0 || presentedMac.length !== MAC_BYTES) return reject("ACK_MALFORMED");
  if (!timingSafeEqual(presentedMac, computeMac(deriveAckKey(secret), cartId, payload))) return reject("ACK_UNVERIFIED");

  // Authentic and bound to this cart; only now is the payload read, and only for its two facts.
  const match = ACK_PATTERN.exec(payload.toString("utf8"));
  if (match === null) return reject("ACK_MALFORMED");
  if (!validateQuoteStructure(currentQuote).ok) return reject("ACK_STALE");
  if (!benefitQuoteNeedsNonclaimAcknowledgement(currentQuote)) return reject("ACK_NOT_REQUIRED");
  if (match[2] !== benefitQuoteDigest(currentQuote)) return reject("ACK_STALE");

  const issuedAt = Number(match[1]);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || issuedAt > nowSeconds + ACK_CLOCK_SKEW_SECONDS) return reject("ACK_MALFORMED");
  if (nowSeconds - issuedAt > MAX_NONCLAIM_ACK_AGE_SECONDS) return reject("ACK_EXPIRED");
  return Object.freeze({ ok: true as const, acknowledgedAt: new Date(issuedAt * 1000) });
}
