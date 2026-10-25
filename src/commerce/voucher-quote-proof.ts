import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { VoucherCampaign } from "./voucher-campaign.ts";
import type { VoucherQuote } from "./voucher-quote.ts";

/**
 * Voucher v1 (V10): the signed binding between a voucher quote, the cart it was built from and the holds that
 * guarantee it (spec §5.1, §6, AC-22/23/31/34).
 *
 * It follows the rules of the checkout quote proof (`checkout-quote-proof.ts`) and deliberately shares none of its
 * bytes, so every no-voucher cart, every in-flight `laq2`/`laq3` proof and every historical order keeps meaning
 * exactly what it did:
 *
 *  - **Stateless.** An HMAC over canonical bytes; the DB hold, not the token, is the entitlement.
 *  - **The cart id is MAC context, never payload.** The token cannot be replayed on another cart and does not hand
 *    the HttpOnly cookie back to the browser. Hold references are opaque ids, not cart ids.
 *  - **It never returns money.** Verification answers "does this token describe the quote the server just
 *    recomputed?" and nothing else; a caller that read an amount out of a token would make the browser the price
 *    authority.
 *  - **ABA-safe.** The cart's monotonic `paidRevision` is part of the facts, so a cart changed and changed back is
 *    a different quote.
 *
 * Two states. `PREVIEW` carries no hold and can never authorize a submit (`HOLD_REQUIRED`); `HELD` carries one hold
 * reference per voucher and an expiry, and stops being valid at the earliest expiry (absolute, never extended).
 */

export const VOUCHER_PROOF_FORMAT = "lav1";
export const MAX_VOUCHER_QUOTE_PROOF_BYTES = 16 * 1024;
const KEY_CONTEXT = "la-clothing:voucher-quote-proof-key:v1";
const MIN_SECRET_LENGTH = 32;
const MAC_BYTES = 32;
const PROOF_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LINES = 400;

export type VoucherProofBinding = Readonly<{
  campaignId: string;
  campaignRevision: number;
  /** Merchandise: the discount D. Shipping: the fee waived. */
  amountVnd: number;
  /** HELD only: the opaque hold reference and its absolute expiry (epoch ms). */
  hold: Readonly<{ holdId: string; expiresAtMs: number }> | null;
}>;

export type VoucherProofLine = Readonly<{
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
  role: "PAID" | "GIFT";
}>;

export type VoucherProofFacts = Readonly<{
  state: "PREVIEW" | "HELD";
  /** The cart's monotonic paid-line version. */
  paidRevision: bigint;
  /** What the buyer is charged for, after the voucher, as the vendor will see it (segments, gifts at 0). */
  lines: readonly VoucherProofLine[];
  paidSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  merchandise: VoucherProofBinding | null;
  shipping: VoucherProofBinding | null;
}>;

export type VoucherProofRejection =
  | "PROOF_MISSING"
  | "PROOF_OVERSIZED"
  | "PROOF_MALFORMED"
  | "PROOF_UNVERIFIED"
  /** Genuinely ours but it describes a quote that is no longer current (price, voucher, revision or cart changed). */
  | "STALE_QUOTE"
  /** A preview proof offered where a held voucher is required. */
  | "HOLD_REQUIRED"
  /** The earliest hold has reached its absolute expiry. */
  | "HOLD_EXPIRED";

export type VoucherProofVerification =
  | Readonly<{ ok: true; held: boolean }>
  | Readonly<{ ok: false; reason: VoucherProofRejection }>;

const isVnd = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
const byLine = (a: VoucherProofLine, b: VoucherProofLine) =>
  a.role.localeCompare(b.role) || (a.pancakeVariationId < b.pancakeVariationId ? -1 : a.pancakeVariationId > b.pancakeVariationId ? 1 : 0) || b.unitPriceVnd - a.unitPriceVnd || a.quantity - b.quantity;

function bindingOk(binding: VoucherProofBinding | null, state: VoucherProofFacts["state"]): boolean {
  if (binding === null) return true;
  if (!binding || !ID_PATTERN.test(binding.campaignId) || !isVnd(binding.campaignRevision, 1) || binding.campaignRevision > 2_147_483_647 || !isVnd(binding.amountVnd, 1)) return false;
  if (state === "PREVIEW") return binding.hold === null;
  return binding.hold !== null && ID_PATTERN.test(binding.hold.holdId) && isVnd(binding.hold.expiresAtMs, 1);
}

/** Whether the facts are a bounded, internally consistent quote. Proofs are only ever issued over valid facts. */
export function areUsableVoucherProofFacts(facts: VoucherProofFacts): boolean {
  if (
    !facts || (facts.state !== "PREVIEW" && facts.state !== "HELD") || typeof facts.paidRevision !== "bigint" || facts.paidRevision < BigInt(0) ||
    !Array.isArray(facts.lines) || facts.lines.length === 0 || facts.lines.length > MAX_LINES ||
    !isVnd(facts.paidSubtotalVnd, 1) || !isVnd(facts.shippingFeeVnd) || !isVnd(facts.totalVnd, 1) ||
    facts.paidSubtotalVnd + facts.shippingFeeVnd !== facts.totalVnd ||
    !bindingOk(facts.merchandise, facts.state) || !bindingOk(facts.shipping, facts.state)
  ) {
    return false;
  }
  let paid = 0;
  for (const line of facts.lines) {
    if (
      !line || typeof line.pancakeVariationId !== "string" || line.pancakeVariationId.length === 0 || line.pancakeVariationId.length > 128 ||
      !isVnd(line.quantity, 1) || (line.role !== "PAID" && line.role !== "GIFT") ||
      (line.role === "PAID" ? !isVnd(line.unitPriceVnd, 1) : line.unitPriceVnd !== 0)
    ) {
      return false;
    }
    if (line.role === "PAID") paid += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(paid)) return false;
  }
  return paid === facts.paidSubtotalVnd;
}

function bindingBytes(tag: string, binding: VoucherProofBinding | null): string {
  if (binding === null) return `|${tag}-`;
  const hold = binding.hold === null ? "-" : `${text(binding.hold.holdId)}@${binding.hold.expiresAtMs}`;
  return `|${tag}${text(binding.campaignId)}@${binding.campaignRevision}:${binding.amountVnd}:${hold}`;
}

/** Deterministic and self-delimiting; lines are sorted here rather than trusted from the caller. */
function canonicalBytes(facts: VoucherProofFacts): Buffer {
  if (!areUsableVoucherProofFacts(facts)) throw new TypeError("Voucher proof facts must be a bounded, consistent quote");
  const lines = [...facts.lines].sort(byLine);
  let canonical = `${VOUCHER_PROOF_FORMAT}|${facts.state}|${facts.paidRevision.toString()}|${facts.paidSubtotalVnd}|${facts.shippingFeeVnd}|${facts.totalVnd}|${lines.length}`;
  for (const line of lines) canonical += `|L${line.role}:${text(line.pancakeVariationId)}:${line.quantity}:${line.unitPriceVnd}`;
  canonical += bindingBytes("M", facts.merchandise) + bindingBytes("S", facts.shipping);
  return Buffer.from(canonical, "utf8");
}

/** SHA-256 (hex) of the canonical bytes: identifies a voucher quote; not a secret and proves nothing by itself. */
export function voucherQuoteDigest(facts: VoucherProofFacts): string {
  return createHash("sha256").update(canonicalBytes(facts)).digest("hex");
}

function deriveKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) throw new TypeError("Voucher quote proof requires the validated server secret");
  return createHmac("sha256", secret).update(KEY_CONTEXT).digest();
}

function mac(key: Buffer, cartId: string, payload: Buffer): Buffer {
  const cart = Buffer.from(cartId, "utf8");
  return createHmac("sha256", key).update(Buffer.from(`${cart.length}:`, "utf8")).update(cart).update(payload).digest();
}

function requireCartId(cartId: string): string {
  if (typeof cartId !== "string" || cartId.length === 0) throw new TypeError("Voucher quote proof requires a server-read cart identity");
  return cartId;
}

/** Issues a proof, or `null` when it would exceed the envelope. Inconsistent facts are a programming error and throw. */
export function issueVoucherQuoteProof(input: Readonly<{ facts: VoucherProofFacts; cartId: string; secret: string }>): string | null {
  const payload = canonicalBytes(input.facts);
  const proof = `${payload.toString("base64url")}.${mac(deriveKey(input.secret), requireCartId(input.cartId), payload).toString("base64url")}`;
  return Buffer.byteLength(proof, "utf8") > MAX_VOUCHER_QUOTE_PROOF_BYTES ? null : proof;
}

/**
 * Does this token describe `current`, the quote the server just recomputed? `mode: "SUBMIT"` additionally requires
 * a HELD proof whose earliest hold has not reached its expiry at `now`; `mode: "PREVIEW"` accepts either state.
 */
export function verifyVoucherQuoteProof(input: Readonly<{
  proof: unknown;
  cartId: string;
  current: VoucherProofFacts;
  secret: string;
  mode: "PREVIEW" | "SUBMIT";
  now: Date;
}>): VoucherProofVerification {
  const reject = (reason: VoucherProofRejection) => Object.freeze({ ok: false as const, reason });
  const { proof, cartId, current, secret, mode, now } = input;
  if (typeof cartId !== "string" || cartId.length === 0) return reject("PROOF_UNVERIFIED");
  if (typeof proof !== "string" || proof.length === 0) return reject("PROOF_MISSING");
  if (Buffer.byteLength(proof, "utf8") > MAX_VOUCHER_QUOTE_PROOF_BYTES) return reject("PROOF_OVERSIZED");
  if (!PROOF_PATTERN.test(proof)) return reject("PROOF_MALFORMED");
  const separator = proof.indexOf(".");
  const payload = Buffer.from(proof.slice(0, separator), "base64url");
  const presented = Buffer.from(proof.slice(separator + 1), "base64url");
  if (payload.length === 0 || presented.length !== MAC_BYTES) return reject("PROOF_MALFORMED");
  if (!timingSafeEqual(presented, mac(deriveKey(secret), cartId, payload))) return reject("PROOF_UNVERIFIED");

  // Authentic and bound to this cart. A current quote that is not itself well formed cannot match.
  if (!areUsableVoucherProofFacts(current) || !payload.equals(canonicalBytes(current))) return reject("STALE_QUOTE");
  if (mode === "SUBMIT") {
    if (current.state !== "HELD") return reject("HOLD_REQUIRED");
    const expiries = [current.merchandise?.hold?.expiresAtMs, current.shipping?.hold?.expiresAtMs].filter((value): value is number => value !== undefined);
    if (expiries.length === 0) return reject("HOLD_REQUIRED");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() >= Math.min(...expiries)) return reject("HOLD_EXPIRED");
  }
  return Object.freeze({ ok: true as const, held: current.state === "HELD" });
}

/**
 * The proof facts for a computed voucher quote. `lines` are the vendor-facing lines AFTER the voucher (the chosen
 * allocation's segments) plus any gift; `holds` is empty for a preview and carries one hold per chosen voucher for
 * a held quote.
 */
export function voucherProofFactsFromQuote(input: Readonly<{
  quote: Extract<VoucherQuote, { ok: true }>;
  campaigns: readonly VoucherCampaign[];
  paidRevision: bigint;
  lines: readonly VoucherProofLine[];
  holds?: Readonly<{ merchandise?: { holdId: string; expiresAtMs: number }; shipping?: { holdId: string; expiresAtMs: number } }>;
}>): VoucherProofFacts {
  const { quote, campaigns, holds } = input;
  const revisionOf = new Map(campaigns.map((campaign) => [campaign.id, campaign.revision]));
  const bind = (campaignId: string | null, amountVnd: number, hold: { holdId: string; expiresAtMs: number } | undefined): VoucherProofBinding | null => {
    if (campaignId === null) return null;
    const campaignRevision = revisionOf.get(campaignId);
    if (campaignRevision === undefined) throw new TypeError("Voucher proof binds a voucher the quote was not built from");
    return { campaignId, campaignRevision, amountVnd, hold: hold ?? null };
  };
  const held = holds !== undefined && (holds.merchandise !== undefined || holds.shipping !== undefined);
  return {
    state: held ? "HELD" : "PREVIEW",
    paidRevision: input.paidRevision,
    lines: input.lines,
    paidSubtotalVnd: quote.paidAfterVnd,
    shippingFeeVnd: quote.shippingFeeVnd,
    totalVnd: quote.totalPayableVnd,
    merchandise: bind(quote.selection.merchandiseId, quote.merchandiseDiscountVnd, holds?.merchandise),
    shipping: bind(quote.selection.shippingId, quote.shippingDiscountVnd, holds?.shipping),
  };
}
