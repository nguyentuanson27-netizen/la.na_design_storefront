/**
 * Manual advanced matching for the browser pixel.
 *
 * The Conversions API already sends `ph`/`fn`/`ln` with Purchase; this gives the pixel's own events
 * from the same checkout the same keys. Values are hashed here, with the normalization the server
 * uses, so the pixel never receives the plain phone number or name and both sides hash identically.
 *
 * Nothing is read until the shopper submits checkout: there is no identity on the page before then,
 * and nothing is kept past the pixel call (no storage), so a reload starts without it.
 */

import {
  hasMetaNameLetter,
  isMetaPhone,
  normalizeMetaIdentifier,
  normalizeVietnamesePhone,
  splitVietnameseName,
} from "../../integrations/meta/identity-normalization.ts";
import { readConsentPolicy, resolveConsentDefaults } from "../../tracking/consent.ts";
import { updateFacebookPixelUserData } from "./facebook-pixel-client.ts";

export type MetaAdvancedMatching = Readonly<{ ph?: string; fn?: string; ln?: string }>;

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hashed keys for what the checkout form collected; a field Meta could not match on is omitted. */
export async function buildMetaAdvancedMatching(
  input: Readonly<{ name: string; phone: string }>,
): Promise<MetaAdvancedMatching> {
  const phone = normalizeVietnamesePhone(input.phone);
  const name = splitVietnameseName(input.name);

  const [ph, fn, ln] = await Promise.all([
    phone !== null && isMetaPhone(phone) ? sha256Hex(phone) : undefined,
    name !== null && hasMetaNameLetter(name.fn) ? sha256Hex(normalizeMetaIdentifier(name.fn)) : undefined,
    name !== null && hasMetaNameLetter(name.ln) ? sha256Hex(normalizeMetaIdentifier(name.ln)) : undefined,
  ]);

  const matching: { ph?: string; fn?: string; ln?: string } = {};
  if (ph !== undefined) matching.ph = ph;
  if (fn !== undefined) matching.fn = fn;
  if (ln !== undefined) matching.ln = ln;
  return matching;
}

/**
 * Each attempt takes the next number, and only the newest, unexpired attempt may touch the pixel.
 * A hash that outlives the next checkout (or its own wait) would otherwise `init` an older shopper
 * on top of a newer one.
 */
let latestAttempt = 0;

/** Set by the pixel snippet only while `LA_META_ADVANCED_MATCHING_ENABLED` is on. */
function isAdvancedMatchingEnabled(): boolean {
  return typeof window !== "undefined"
    && (window as { laMetaAdvancedMatching?: unknown }).laMetaAdvancedMatching === true;
}

async function sendToPixel(
  input: Readonly<{ name: string; phone: string }>,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    if (!isAdvancedMatchingEnabled()) return;
    if (resolveConsentDefaults(readConsentPolicy()).ad_user_data !== "granted") return;
    const matching = await buildMetaAdvancedMatching(input);
    if (!isCurrent()) return;
    if (Object.keys(matching).length === 0) return;
    updateFacebookPixelUserData(matching);
  } catch {
    // Tracking failures stay invisible to the shopper.
  }
}

/**
 * Sends the shopper's checkout identity to the pixel, if consent for advertising user data is
 * granted. Never throws and never delays the caller: matching is an enhancement, and the order must
 * not wait on, or fail because of, a hash or a blocked pixel.
 */
export function applyMetaAdvancedMatching(
  input: Readonly<{ name: string; phone: string }>,
): Promise<void> {
  const attempt = ++latestAttempt;
  return sendToPixel(input, () => attempt === latestAttempt);
}

/** Longest checkout waits for the pixel to hear the shopper; a hash takes microseconds. */
export const META_ADVANCED_MATCHING_MAX_WAIT_MS = 300;

/**
 * `applyMetaAdvancedMatching`, but resolves no later than `maxWaitMs`, so a caller can order "pixel
 * hears the shopper" before "order submitted" without letting analytics hold a checkout. Never
 * rejects. An attempt that has run out of time is abandoned: it never reaches the pixel afterwards,
 * so a late hash cannot replace what a newer checkout has already sent.
 */
export function applyMetaAdvancedMatchingWithin(
  input: Readonly<{ name: string; phone: string }>,
  maxWaitMs: number = META_ADVANCED_MATCHING_MAX_WAIT_MS,
): Promise<void> {
  // Switched off: nothing to send, so nothing to wait for.
  if (!isAdvancedMatchingEnabled()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const attempt = ++latestAttempt;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      resolve();
    }, maxWaitMs);
    void sendToPixel(input, () => !expired && attempt === latestAttempt).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
