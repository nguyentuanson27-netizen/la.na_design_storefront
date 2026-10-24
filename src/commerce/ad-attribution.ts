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

/** Same ceiling the shopper's own note is held to (`guest-checkout-input.ts`), so UTM never raises the worst case. */
const MAX_NOTE_LENGTH = 2_048;
const NOTE_SEPARATOR = " | ";
/** Below this much room a clipped line says too little to be worth sending. */
const MIN_ATTRIBUTION_LENGTH = 40;

/**
 * The shopper's own text can say anything, including `[UTM] source=google`. Staff read that tag as
 * the system's, so it is defused in what the shopper typed; the real one is only ever appended here.
 */
function defuseAttributionTag(customerNote: string): string {
  return customerNote.replace(/\[\s*UTM\s*\]/giu, "(UTM)");
}

/**
 * The note sent to Pancake: what the shopper typed, then the attribution line.
 *
 * The line is a hint, not a requirement of the order, so it yields to everything else: it is
 * clipped to what is left under the shopper's own note limit, and left out when too little is left,
 * so a long note is never what tips an order over a limit the POS may enforce.
 */
export function composeOrderNote(customerNote: string | null, attribution: string | null): string | null {
  const note = customerNote === null ? null : defuseAttributionTag(customerNote);
  if (attribution === null) return note;
  if (note === null) return attribution.slice(0, MAX_NOTE_LENGTH);
  const room = MAX_NOTE_LENGTH - note.length - NOTE_SEPARATOR.length;
  if (room < MIN_ATTRIBUTION_LENGTH) return note;
  return `${note}${NOTE_SEPARATOR}${attribution.slice(0, room).trimEnd()}`;
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
