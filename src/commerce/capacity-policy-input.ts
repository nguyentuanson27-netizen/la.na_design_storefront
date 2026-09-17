/**
 * I2 — fail-closed validation for the selling-policy admin write (ADR 0014 §5, §11).
 *
 * Nothing here touches Prisma, so the rules can be tested exhaustively without a database and cannot
 * drift between call sites — the same division `merchandising-input.ts` already uses for the
 * merchandising writes.
 *
 * The mode is an **allowlist of three exact strings**, not a coercion. `resolveSellingPolicy()`
 * deliberately answers an unrecognized *stored* mode with `STANDARD`, because no owner intent
 * survives in a value that names no mode — but that is a read-path repair for rows that already
 * exist. Applying the same leniency on write would turn a typo into a silent demotion to `STANDARD`,
 * and the operator would be told their change was saved. A submission that names no mode is refused.
 */

import { DEFAULT_NEGATIVE_STOCK_LIMIT, type SellingMode } from "./capacity-policy.ts";

/**
 * What an operator submits, and what I3's radio group will post. Lowercase and mutually exclusive:
 * the storage enum is an implementation detail the browser has no business knowing.
 */
export const SELLING_POLICY_MODE_INPUTS = ["standard", "oversell", "preorder"] as const;

export type SellingPolicyModeInput = (typeof SELLING_POLICY_MODE_INPUTS)[number];

const MODE_BY_INPUT: Readonly<Record<SellingPolicyModeInput, SellingMode>> = Object.freeze({
  standard: "STANDARD",
  oversell: "OVERSELL",
  preorder: "PREORDER",
});

/** Product ids are `cuid`s from `ProductMirror.id`; this bounds the string, not its alphabet. */
const MAX_PRODUCT_ID_LENGTH = 64;

/**
 * The most negative allowance an operator may set in one submission.
 *
 * An operational bound rather than an approved fact — master spec §29 fixes no floor. It exists so
 * that a mistyped `-2000` is refused at the boundary instead of quietly authorizing two thousand
 * units of unbacked demand. The approved default is `−20`; anything beyond this bound is a decision
 * the owner should make explicitly, not a form field.
 */
export const MAX_NEGATIVE_STOCK_ALLOWANCE = -200;

export type SellingPolicyErrorReason =
  | "selling-policy-shape"
  | "selling-policy-invalid-product"
  | "selling-policy-unknown-mode"
  | "selling-policy-invalid-limit"
  | "selling-policy-composite-restricted";

export class SellingPolicyError extends Error {
  readonly reason: SellingPolicyErrorReason;

  constructor(reason: SellingPolicyErrorReason) {
    super(reason);
    this.name = "SellingPolicyError";
    this.reason = reason;
  }
}

export type SellingPolicySubmission = Readonly<{
  productId: string;
  sellingMode: SellingMode;
  negativeStockLimit: number;
}>;

function parseProductId(value: unknown): string {
  if (typeof value !== "string") throw new SellingPolicyError("selling-policy-invalid-product");
  const productId = value.trim();
  if (productId.length === 0 || productId.length > MAX_PRODUCT_ID_LENGTH) {
    throw new SellingPolicyError("selling-policy-invalid-product");
  }
  return productId;
}

function parseSellingMode(value: unknown): SellingMode {
  if (typeof value !== "string") throw new SellingPolicyError("selling-policy-unknown-mode");
  const mode = MODE_BY_INPUT[value as SellingPolicyModeInput];
  // `MODE_BY_INPUT` is a plain object, so an inherited key like "constructor" would otherwise
  // resolve to something truthy. `Object.freeze` does not prevent that; checking the allowlist does.
  if (mode === undefined || !SELLING_POLICY_MODE_INPUTS.includes(value as SellingPolicyModeInput)) {
    throw new SellingPolicyError("selling-policy-unknown-mode");
  }
  return mode;
}

/**
 * The oversell allowance, as a non-positive integer.
 *
 * Absent means the approved default, so a form that does not render the field for `standard` still
 * submits something storable. `null` is treated the same way — an emptied input is "use the
 * default", not "no limit". A positive value is refused rather than negated: `evaluateVariantCapacity`
 * refuses it as `invalid-limit` at the gate, and storing one would leave a product whose configured
 * policy can never sell anything, with nothing on the admin surface to explain why.
 */
function parseNegativeStockLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_NEGATIVE_STOCK_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SellingPolicyError("selling-policy-invalid-limit");
  }
  if (value > 0 || value < MAX_NEGATIVE_STOCK_ALLOWANCE) {
    throw new SellingPolicyError("selling-policy-invalid-limit");
  }
  return value;
}

/**
 * Parse one admin submission.
 *
 * The limit is parsed and stored for every mode, `STANDARD` included. §5 floors `STANDARD` at 0
 * whatever the limit says, so the stored value is inert there — but discarding it would lose the
 * allowance an operator had already set the moment they switched a product to `standard` and back,
 * and silently losing a configured value is worse than carrying an inert one.
 */
export function parseSellingPolicySubmission(input: unknown): SellingPolicySubmission {
  if (typeof input !== "object" || input === null) {
    throw new SellingPolicyError("selling-policy-shape");
  }
  const record = input as Record<string, unknown>;

  return Object.freeze({
    productId: parseProductId(record.productId),
    sellingMode: parseSellingMode(record.sellingMode),
    negativeStockLimit: parseNegativeStockLimit(record.negativeStockLimit),
  });
}
