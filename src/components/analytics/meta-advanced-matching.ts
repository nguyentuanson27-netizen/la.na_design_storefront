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
 * Sends the shopper's checkout identity to the pixel, if consent for advertising user data is
 * granted. Never throws and never delays the caller: matching is an enhancement, and the order must
 * not wait on, or fail because of, a hash or a blocked pixel.
 */
export async function applyMetaAdvancedMatching(
  input: Readonly<{ name: string; phone: string }>,
): Promise<void> {
  try {
    if (resolveConsentDefaults(readConsentPolicy()).ad_user_data !== "granted") return;
    const matching = await buildMetaAdvancedMatching(input);
    if (Object.keys(matching).length === 0) return;
    updateFacebookPixelUserData(matching);
  } catch {
    // See above: tracking failures stay invisible to the shopper.
  }
}

/** Longest checkout waits for the pixel to hear the shopper; a hash takes microseconds. */
export const META_ADVANCED_MATCHING_MAX_WAIT_MS = 300;

/**
 * `applyMetaAdvancedMatching`, but resolves no later than `maxWaitMs`, so a caller can order "pixel
 * hears the shopper" before "order submitted" without letting analytics hold a checkout. Never
 * rejects. A hash that finishes after the wait still updates the pixel; it just may land after the
 * first browser event of the next page.
 */
export function applyMetaAdvancedMatchingWithin(
  input: Readonly<{ name: string; phone: string }>,
  maxWaitMs: number = META_ADVANCED_MATCHING_MAX_WAIT_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxWaitMs);
    void applyMetaAdvancedMatching(input).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
