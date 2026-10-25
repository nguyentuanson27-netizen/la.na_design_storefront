import { normalizeVoucherCode } from "./voucher-rule-validation.ts";

/**
 * Voucher v1 (V19): safe KOL / private-code links (spec §8, AC-13, AC-40).
 *
 * A link such as `/shop/san-pham?voucher=KOL50` carries an intent, not an entitlement. The code must never reach a
 * document that loads GTM, Meta or analytics, so the very first request is answered with a body-less redirect to the
 * same URL WITHOUT the `voucher` parameter (and a `no-referrer` policy), by way of the server-side handler that
 * validates the code and stores the choice against the cart. The browser, its history, the Referer header and every
 * script therefore only ever see the clean URL. A code that is invalid or malformed is still stripped.
 *
 * Pure: it builds URLs and cookies and decides nothing about money. The destination is always rebuilt from the
 * request's own path, never from a user-supplied `next`, and the handler re-checks it, so this cannot be an open
 * redirect.
 */

export const VOUCHER_LINK_PARAM = "voucher";
export const VOUCHER_LINK_PATH = "/voucher-link";
export const VOUCHER_INTENT_COOKIE = "la_voucher_code";
export const VOUCHER_INTENT_MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_RAW_CODE_LENGTH = 64;
const MAX_TARGET_LENGTH = 512;

/** Pages a link may land on. Everything else ignores the parameter (and keeps it out of our redirects). */
const LANDING_PATHS: readonly RegExp[] = [/^\/$/, /^\/shop$/, /^\/shop\/[^/]+$/, /^\/cart$/, /^\/sale$/, /^\/new-arrivals$/, /^\/vay-dam$/, /^\/ao-dai(?:\/[^/]+)?$/, /^\/set-do(?:\/[^/]+)?$/, /^\/phu-kien$/];

export const VOUCHER_REDIRECT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
});

/** Whether `target` is a same-origin path to a page links may land on; no scheme, no `//`, no backslash, no control chars. */
export function isSafeLandingTarget(target: unknown): target is string {
  if (typeof target !== "string" || target.length === 0 || target.length > MAX_TARGET_LENGTH) return false;
  if (!target.startsWith("/") || target.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(target)) return false;
  let url: URL;
  try {
    url = new URL(target, "https://storefront.invalid");
  } catch {
    return false;
  }
  if (url.origin !== "https://storefront.invalid" || url.searchParams.has(VOUCHER_LINK_PARAM)) return false;
  return LANDING_PATHS.some((pattern) => pattern.test(url.pathname));
}

export type VoucherLinkRedirect = Readonly<{
  /** Where the proxy sends the browser first: the handler, carrying the code and the clean target. */
  handlerPath: string;
  /** The clean landing URL (path + remaining query), never containing the code. */
  cleanTarget: string;
}>;

/**
 * For a GET to a landing page with exactly one `voucher` parameter, the redirect to take; otherwise null.
 * `code` is whatever the link said (bounded); the handler normalizes and validates it.
 */
export function planVoucherLinkRedirect(input: Readonly<{ method: string; pathname: string; search: string }>): VoucherLinkRedirect | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  if (!LANDING_PATHS.some((pattern) => pattern.test(input.pathname))) return null;
  const params = new URLSearchParams(input.search);
  const values = params.getAll(VOUCHER_LINK_PARAM);
  if (values.length === 0) return null;
  params.delete(VOUCHER_LINK_PARAM);
  const rest = params.toString();
  const cleanTarget = rest.length === 0 ? input.pathname : `${input.pathname}?${rest}`;
  if (!isSafeLandingTarget(cleanTarget)) return null;
  const raw = values.length === 1 ? values[0]! : "";
  const code = raw.length <= MAX_RAW_CODE_LENGTH && normalizeVoucherCode(raw) !== null ? raw : "";
  // An unusable code is still removed from the URL; the handler simply has nothing to apply.
  const handlerPath = code === "" ? cleanTarget : `${VOUCHER_LINK_PATH}?${new URLSearchParams({ code, to: cleanTarget }).toString()}`;
  return { handlerPath, cleanTarget };
}

export function serializeVoucherIntentCookie(code: string, storefrontOrigin: string): string {
  const canonical = normalizeVoucherCode(code);
  if (canonical === null) throw new TypeError("Voucher intent cookie needs a valid code");
  const attributes = [`${VOUCHER_INTENT_COOKIE}=${canonical}`, "Path=/", `Max-Age=${VOUCHER_INTENT_MAX_AGE_SECONDS}`, "SameSite=Lax", "HttpOnly"];
  if (new URL(storefrontOrigin).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

export function clearVoucherIntentCookie(storefrontOrigin: string): string {
  const attributes = [`${VOUCHER_INTENT_COOKIE}=`, "Path=/", "Max-Age=0", "SameSite=Lax", "HttpOnly"];
  if (new URL(storefrontOrigin).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

/** The pending code a visitor without a cart arrived with, canonical or null. */
export function readVoucherIntentCookie(value: string | undefined): string | null {
  return value === undefined ? null : normalizeVoucherCode(value);
}
