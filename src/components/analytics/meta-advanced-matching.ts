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
  const matching: { ph?: string; fn?: string; ln?: string } = {};

  const phone = normalizeVietnamesePhone(input.phone);
  if (phone !== null && isMetaPhone(phone)) matching.ph = await sha256Hex(phone);

  const name = splitVietnameseName(input.name);
  if (name !== null) {
    if (hasMetaNameLetter(name.fn)) matching.fn = await sha256Hex(normalizeMetaIdentifier(name.fn));
    if (hasMetaNameLetter(name.ln)) matching.ln = await sha256Hex(normalizeMetaIdentifier(name.ln));
  }
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
