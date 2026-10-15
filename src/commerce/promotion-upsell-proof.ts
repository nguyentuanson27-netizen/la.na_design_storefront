/** Reuses COD's bounded HMAC/canonical quote format, with a domain-specific MAC context.
 * The ordinary COD proof cannot bind a paid-write revision or the selected +1 intent (UP-00).
 * No nonce table, new secret, or client-reported money. Five-minute lifetime, verified by the server.
 */
import { createHmac } from "node:crypto";
import { benefitQuoteDigest, issueBenefitQuoteProof, issueRenderedQuoteProof, verifyBenefitQuoteProof, verifyRenderedQuoteProof, type RenderedQuoteProofFacts } from "./checkout-quote-proof.ts";
import type { QuoteStructure } from "./order-quote-rules.ts";

export const UPSELL_PROOF_TTL_MS = 5 * 60_000;
export type UpsellQuote = { kind: "LEGACY"; facts: RenderedQuoteProofFacts } | { kind: "BENEFIT"; facts: QuoteStructure };
export type UpsellIntent = Readonly<{ campaignId: string; variantId: string; issuedAt: number; proof: string }>;
export function parseUpsellIntent(input: unknown): UpsellIntent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "campaignId,issuedAt,proof,variantId") return null;
  if (![r.campaignId, r.variantId].every((v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v))) return null;
  if (!Number.isSafeInteger(r.issuedAt) || (r.issuedAt as number) < 0 || typeof r.proof !== "string" || r.proof.length > 65536) return null;
  return r as UpsellIntent;
}
export function issueUpsellQuoteProof(quote: UpsellQuote, cartId: string, secret: string): string | null {
  return quote.kind === "BENEFIT" ? issueBenefitQuoteProof({ quote: quote.facts, cartId, secret }) : issueRenderedQuoteProof({ quote: quote.facts, cartId, secret });
}
export function verifiesUpsellQuote(quote: UpsellQuote, proof: unknown, cartId: string, secret: string): boolean {
  return quote.kind === "BENEFIT" ? verifyBenefitQuoteProof({ currentQuote: quote.facts, proof, cartId, secret }).ok : verifyRenderedQuoteProof({ currentQuote: quote.facts, proof, cartId, secret }).ok;
}
export function upsellQuoteDigest(quote: UpsellQuote): string {
  if (quote.kind === "BENEFIT") return benefitQuoteDigest(quote.facts);
  return createHmac("sha256", "upsell-legacy-digest-v1").update(JSON.stringify(quote.facts)).digest("hex");
}
/** All arguments here are independently recomputed server facts, except the authenticated issue time. */
export function upsellProofContext(cartId: string, paidRevision: bigint, campaignRevision: number, intent: Omit<UpsellIntent, "proof">, after: UpsellQuote): string {
  return JSON.stringify(["la-upsell-v1", cartId, String(paidRevision), campaignRevision, intent.campaignId, intent.variantId, intent.issuedAt, upsellQuoteDigest(after)]);
}
export function isUpsellProofCurrent(issuedAt: number, now: Date): boolean {
  return Number.isSafeInteger(issuedAt) && issuedAt <= now.getTime() && now.getTime() - issuedAt < UPSELL_PROOF_TTL_MS;
}
/** Opaque per-cart paid version for UI invalidation; no raw UUID/revision is sent to the browser. */
export function upsellPaidCartKey(cartId: string, paidRevision: bigint, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify(["la-upsell-ui-v1", cartId, String(paidRevision)])).digest("base64url");
}
