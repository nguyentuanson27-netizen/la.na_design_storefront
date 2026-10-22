/**
 * The per-request script nonce layered on top of the storefront's Content-Security-Policy.
 *
 * `next.config.mjs` owns the baseline policy and sends it with every response. It has to allow
 * inline scripts, because a header baked at build time cannot know a nonce that only exists per
 * request. For page loads the proxy adds a second, stricter policy: the same directives, with
 * `script-src` led by a fresh nonce and `'strict-dynamic'`. A CSP3 browser then runs only scripts
 * that carry the nonce, plus whatever those scripts load, and ignores `'unsafe-inline'` and the
 * host list -- which stay in the directive as the fallback for browsers that predate nonces.
 *
 * In `enforce` the response carries both policies and both are enforced, so the baseline's host
 * list still bounds what a trusted script may load; the stricter policy can only take permissions
 * away.
 *
 * `LA_CSP_STRICT_SCRIPTS` decides what the stricter policy does, at runtime, so a rollout and a
 * rollback are an environment change:
 *
 * - `report-only` (default): sent as `Content-Security-Policy-Report-Only`. Nothing is blocked;
 *   the browser reports what enforcing it would block to `CSP_REPORT_PATH`.
 * - `enforce`: sent as `Content-Security-Policy`. Inline scripts without the nonce stop running.
 * - `off`: no stricter policy, no nonce. The baseline alone, as before.
 */

export type StrictScriptPolicyMode = "off" | "report-only" | "enforce";

export const STRICT_SCRIPT_POLICY_ENV = "LA_CSP_STRICT_SCRIPTS";
/** Request header the proxy hands the nonce to server components on. Never read from a browser. */
export const CSP_NONCE_REQUEST_HEADER = "x-la-csp-nonce";
export const CSP_REPORT_PATH = "/api/csp-report";

const ENFORCE_HEADER = "content-security-policy";
const REPORT_ONLY_HEADER = "content-security-policy-report-only";
const NONCE_BYTES = 16;
/** 16 random bytes in standard base64: 22 characters and two padding characters. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

type PolicyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * An unrecognised value falls back to `report-only` rather than failing every page: a typo must
 * not take the storefront down, and report-only neither blocks anything nor loosens the baseline.
 */
export function readStrictScriptPolicyMode(env: PolicyEnvironment = process.env): StrictScriptPolicyMode {
  const value = env[STRICT_SCRIPT_POLICY_ENV]?.trim();
  return value === "off" || value === "enforce" ? value : "report-only";
}

export function createScriptNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function isScriptNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/**
 * The baseline with `script-src` led by the nonce and `'strict-dynamic'`, reporting to
 * `CSP_REPORT_PATH`. Report-only drops `upgrade-insecure-requests`, which browsers ignore (with a
 * console warning) in a report-only policy; the enforced baseline keeps applying it.
 */
export function buildStrictScriptPolicy(
  basePolicy: string,
  nonce: string,
  mode: Exclude<StrictScriptPolicyMode, "off">,
): string {
  if (!isScriptNonce(nonce)) throw new TypeError("A script nonce must be 16 random bytes in base64");

  let hasScriptSrc = false;
  const directives: string[] = [];
  for (const directive of basePolicy.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    if (name === "script-src") {
      hasScriptSrc = true;
      directives.push(["script-src", `'nonce-${nonce}'`, "'strict-dynamic'", ...sources].join(" "));
    } else if (name === "report-uri" || (mode === "report-only" && name === "upgrade-insecure-requests")) {
      continue;
    } else {
      directives.push(directive);
    }
  }
  if (!hasScriptSrc) throw new TypeError("The baseline Content-Security-Policy has no script-src directive");

  directives.push(`report-uri ${CSP_REPORT_PATH}`);
  return directives.join("; ");
}

export type StrictScriptPolicyHeaders = Readonly<{
  /** Request headers to forward to rendering: the nonce, and the policy Next reads it from. */
  request: Headers;
  /**
   * The response header to send, one policy per value in this order, or `null` when the mode is
   * `off`. A proxy's header replaces next.config.mjs's header of the same name, so `enforce` lists
   * the baseline again: both are enforced, and the baseline's host list keeps bounding where a
   * script trusted through 'strict-dynamic' may load from.
   *
   * The stricter policy comes first. Next copies a proxy's response headers onto the request it
   * renders and takes the nonce from the first `script-src` there; with the baseline first it finds
   * none and leaves its own scripts unstamped, which an enforced policy then blocks. Browsers apply
   * every policy regardless of order.
   */
  response: Readonly<{ name: string; values: readonly string[] }> | null;
}>;

/**
 * Builds both halves for one page request. Whatever the browser sent under the policy and nonce
 * header names is dropped first: Next takes its nonce from the request's CSP header, and server
 * components take theirs from `CSP_NONCE_REQUEST_HEADER`, so only the proxy may set either.
 */
export function strictScriptPolicyHeaders(
  incoming: Headers,
  basePolicy: string,
  mode: StrictScriptPolicyMode,
  nonce: string = createScriptNonce(),
): StrictScriptPolicyHeaders {
  const request = new Headers(incoming);
  request.delete(ENFORCE_HEADER);
  request.delete(REPORT_ONLY_HEADER);
  request.delete(CSP_NONCE_REQUEST_HEADER);
  if (mode === "off") return { request, response: null };

  const policy = buildStrictScriptPolicy(basePolicy, nonce, mode);
  const name = mode === "enforce" ? ENFORCE_HEADER : REPORT_ONLY_HEADER;
  request.set(name, policy);
  request.set(CSP_NONCE_REQUEST_HEADER, nonce);
  return { request, response: { name, values: mode === "enforce" ? [policy, basePolicy] : [policy] } };
}

/** The nonce the proxy issued for this request, or `undefined` when there is none. */
export function readRequestScriptNonce(headers: Readonly<{ get(name: string): string | null }>): string | undefined {
  const value = headers.get(CSP_NONCE_REQUEST_HEADER);
  return isScriptNonce(value) ? value : undefined;
}
