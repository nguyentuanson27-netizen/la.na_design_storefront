/**
 * First-party cookies the server writes so Conversions API events match the shopper, the job
 * Meta's Parameter Builder does.
 *
 * - `_fbc`, Meta's click ID. `fbevents.js` writes it from an ad click's `fbclid`, but only where
 *   it runs: an ad blocker, a failed load, or Safari's seven-day cap on script-written cookies all
 *   lose it before the shopper checks out, and the Purchase then carries no click ID. The landing
 *   request already has the `fbclid`, so the server writes the cookie itself, in the format and on
 *   the domain the pixel uses, and the pixel finds it already there.
 * - `la_vid`, this site's own visitor ID, sent to Meta as `external_id` by both the pixel and the
 *   Conversions API so every event from one browser ties together even when Meta's cookies do
 *   not survive. It is 256 random bits, nothing derived from the shopper; written as 64 lowercase
 *   hex digits it is already in the hashed form Meta expects, so both sides send it unchanged.
 */

import { META_COOKIE_MAX_LENGTH, META_FBC_PATTERN } from "./cookie-format.ts";
import { readMetaPagePath } from "./page-source.ts";

export const META_CLICK_ID_COOKIE = "_fbc";
/** Meta attributes a click for up to 90 days; the pixel keeps `_fbc` that long too. */
export const META_CLICK_ID_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const FBCLID_PATTERN = /^[A-Za-z0-9_-]{1,400}$/;

export const META_VISITOR_ID_COOKIE = "la_vid";
export const META_VISITOR_ID_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const META_VISITOR_ID_PATTERN = /^[0-9a-f]{64}$/;

type HeaderReader = Readonly<{ get(name: string): string | null }>;

/**
 * Only a browser loading a public storefront page gets these cookies: the same pages Meta events
 * are reported for (no admin, account, login or API paths, no files), and only the document load
 * itself. HEAD, speculative prefetches, and anything a browser did not ask for as a page are left
 * without a per-visitor Set-Cookie.
 *
 * App Router navigations and prefetches need no rule of their own, and could not have one: Next
 * strips the Flight headers (`rsc`, `next-router-prefetch`) before the proxy sees the request, and
 * the router fetches them with `Sec-Fetch-Dest: empty` and `Accept: text/x-component`.
 */
export function isMetaCookieNavigation(input: Readonly<{
  method: string;
  pathname: string;
  headers: HeaderReader;
}>): boolean {
  const { method, pathname, headers } = input;
  if (method !== "GET" || readMetaPagePath(pathname) === null) return false;
  const purpose = `${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`;
  if (purpose.includes("prefetch")) return false;
  const destination = headers.get("sec-fetch-dest");
  // Every current browser sends Sec-Fetch-Dest; Accept is the fallback for one that does not.
  if (destination !== null) return destination === "document";
  return (headers.get("accept") ?? "").includes("text/html");
}

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

/** The visitor ID a request carries, or null when it has none or it is not one of ours. */
export function readMetaVisitorId(cookieValue: string | null | undefined): string | null {
  return cookieValue && META_VISITOR_ID_PATTERN.test(cookieValue) ? cookieValue : null;
}

/** A fresh visitor ID when the request has no valid one, or null to leave the cookie as it is. */
export function nextMetaVisitorIdCookie(
  existing: string | undefined,
  randomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string | null {
  if (readMetaVisitorId(existing) !== null) return null;
  return Array.from(randomBytes(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Readable from script on purpose (no HttpOnly): the pixel reads both, `_fbc` to keep it rather
 * than write a second one and `la_vid` to send as `external_id`. Neither says anything about who
 * the shopper is.
 *
 * Scoped as the pixel scopes its own cookies. `fbevents.js` writes on the registrable domain, so on
 * production the server must too, or the browser would hold two `_fbc` cookies and send both.
 */
export function serializeMetaFirstPartyCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  storefrontOrigin: string,
): string {
  const origin = new URL(storefrontOrigin);
  const attributes = [`${name}=${value}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "SameSite=Lax"];
  if (origin.hostname.startsWith("www.")) attributes.push(`Domain=${origin.hostname.slice(4)}`);
  if (origin.protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}
