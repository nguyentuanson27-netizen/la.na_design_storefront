/**
 * Server-side persistence of Meta's click ID (`_fbc`), the job Meta's Parameter Builder does.
 *
 * `fbevents.js` writes `_fbc` from an ad click's `fbclid`, but only where it runs: an ad blocker,
 * a failed load, or Safari's seven-day cap on script-written cookies all lose it before the
 * shopper checks out, and the Purchase sent through the Conversions API then carries no click ID.
 * The landing request already has the `fbclid`, so the server writes the cookie itself, in the
 * format and on the domain the pixel uses, and the pixel finds it already there.
 */

import { META_COOKIE_MAX_LENGTH, META_FBC_PATTERN } from "./cookie-format.ts";

export const META_CLICK_ID_COOKIE = "_fbc";
/** Meta attributes a click for up to 90 days; the pixel keeps `_fbc` that long too. */
export const META_CLICK_ID_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const FBCLID_PATTERN = /^[A-Za-z0-9_-]{1,400}$/;

function readClickId(cookieValue: string | undefined): string | null {
  if (!cookieValue || cookieValue.length > META_COOKIE_MAX_LENGTH) return null;
  if (!META_FBC_PATTERN.test(cookieValue)) return null;
  return cookieValue.split(".")[3] ?? null;
}

/**
 * The `_fbc` value to write for this landing, or null to leave the cookie as it is.
 *
 * A cookie that already holds the same click keeps its original creation time: Meta reads that
 * timestamp as when the click happened, so a reload must not move it. A new click replaces it.
 */
export function nextMetaClickIdCookie(input: Readonly<{
  fbclid: string | null;
  existing: string | undefined;
  nowMs: number;
}>): string | null {
  const { fbclid, existing, nowMs } = input;
  if (!fbclid || !FBCLID_PATTERN.test(fbclid) || !Number.isSafeInteger(nowMs)) return null;
  if (readClickId(existing) === fbclid) return null;
  const value = `fb.1.${nowMs}.${fbclid}`;
  return META_FBC_PATTERN.test(value) ? value : null;
}

/**
 * Readable from script on purpose (no HttpOnly): the pixel must see it to keep it rather than
 * write a second one. It carries an opaque ad-click token, nothing about the shopper.
 *
 * The cookie scope the pixel itself uses. `fbevents.js` writes on the registrable domain, so on
 * production the server must too, or the browser would hold two `_fbc` cookies and send both.
 */
export function serializeMetaClickIdCookie(value: string, storefrontOrigin: string): string {
  const origin = new URL(storefrontOrigin);
  const attributes = [
    `${META_CLICK_ID_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${META_CLICK_ID_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (origin.hostname.startsWith("www.")) attributes.push(`Domain=${origin.hostname.slice(4)}`);
  if (origin.protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}
