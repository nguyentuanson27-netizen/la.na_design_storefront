/**
 * UTM attribution for orders that arrive from an ad.
 *
 * The landing request carries `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` /
 * `utm_term` in its query. `proxy.ts` keeps them in the `la_utm` cookie (last touch wins), and
 * checkout turns the cookie into one `[UTM] …` line appended to the order note, so the people
 * working the order in Pancake POS see where it came from. Nothing here is read back to the shopper.
 *
 * Every value is attacker-controlled (a URL, then a cookie the browser can rewrite), and it ends up
 * in a note that the order-marker search also reads. So each value is cut down to a conservative
 * alphabet that has no brackets, `=`, `;` or line breaks: it cannot forge an `[ORDER:…]` marker or
 * a second field, and the cookie round-trips without escaping rules of its own.
 */

export const AD_ATTRIBUTION_COOKIE = "la_utm";
/** Last touch is what gets credited; a month is long enough for a considered purchase. */
export const AD_ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const FIELDS = ["source", "medium", "campaign", "content", "term"] as const;
type AdAttributionField = (typeof FIELDS)[number];

const MAX_VALUE_LENGTH = 100;
const NOTE_PREFIX = "[UTM] ";
/** What `formatAdAttributionNote` can produce: the prefix, then `field=value` pairs. */
const NOTE_PATTERN = /^\[UTM\] [\p{L}\p{N} _.\-:/@,;=]{1,700}$/u;

type QueryReader = Readonly<{ get(name: string): string | null }>;

function cleanValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _.\-:/@,]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VALUE_LENGTH)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

function serializeFields(values: Readonly<Partial<Record<AdAttributionField, string>>>): string | null {
  const pairs = FIELDS.flatMap((field) => {
    const value = cleanValue(values[field]);
    return value === null ? [] : [`${field}=${value}`];
  });
  return pairs.length === 0 ? null : pairs.join(";");
}

function parseFields(serialized: string): Partial<Record<AdAttributionField, string>> {
  const values: Partial<Record<AdAttributionField, string>> = {};
  for (const pair of serialized.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const field = pair.slice(0, separator) as AdAttributionField;
    if (!FIELDS.includes(field) || values[field] !== undefined) continue;
    const value = cleanValue(pair.slice(separator + 1));
    if (value !== null) values[field] = value;
  }
  return values;
}

/** The `la_utm` cookie value for a landing URL's query, or null when it carries no UTM at all. */
export function adAttributionCookieValue(query: QueryReader): string | null {
  const values: Partial<Record<AdAttributionField, string>> = {};
  for (const field of FIELDS) {
    const value = query.get(`utm_${field}`);
    if (value !== null) values[field] = value;
  }
  const serialized = serializeFields(values);
  return serialized === null ? null : encodeURIComponent(serialized);
}

function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The note line for a cookie value, or null when it is absent or holds nothing usable. The cookie is
 * parsed field by field rather than trusted, since the browser can send anything.
 */
export function formatAdAttributionNote(cookieValue: string | null | undefined): string | null {
  if (typeof cookieValue !== "string" || cookieValue.length === 0 || cookieValue.length > 2_000) return null;
  const serialized = serializeFields(parseFields(decodeCookie(cookieValue)));
  return serialized === null ? null : `${NOTE_PREFIX}${serialized}`;
}

/** A note line the checkout input carries is accepted only if it is exactly what this module writes. */
export function normalizeAdAttributionNote(value: unknown): string | null {
  return typeof value === "string" && NOTE_PATTERN.test(value) ? value : null;
}

/** The note sent to Pancake: what the shopper typed, then the attribution line. */
export function composeOrderNote(customerNote: string | null, attribution: string | null): string | null {
  const parts = [customerNote, attribution].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" | ");
}

/**
 * The Set-Cookie for a landing that carries UTM parameters. Host-only (checkout is on the same
 * host) and HttpOnly: no script reads it, only the checkout action.
 */
export function serializeAdAttributionCookie(value: string, storefrontOrigin: string): string {
  const attributes = [
    `${AD_ATTRIBUTION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${AD_ATTRIBUTION_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (new URL(storefrontOrigin).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}
