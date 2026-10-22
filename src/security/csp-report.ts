/**
 * Content-Security-Policy violation reports, reduced to what an operator needs to decide whether
 * the stricter script policy (script-nonce-policy.ts) is safe to enforce: which directive, which
 * origin was blocked, and on which page.
 *
 * The endpoint is public and unauthenticated -- browsers send reports without credentials -- so
 * everything here is treated as untrusted text. Only bounded, categorical values are kept: a URL is
 * reduced to its origin (a blocked script) or its path (the page), never its query, which can carry
 * shopper input; free text such as the script sample is dropped.
 */

export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const CSP_REPORT_CONTENT_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
  "application/json",
]);
/** At most this many violations per window reach the log; the rest are only counted. */
export const CSP_REPORT_LOG_LIMIT = 60;
/** At most this many of them from any one client, so one sender cannot use up the window. */
export const CSP_REPORT_CLIENT_LOG_LIMIT = 10;
export const CSP_REPORT_WINDOW_MS = 60_000;
/** Distinct clients tracked per window; beyond it, new clients share one overflow budget. */
const CSP_REPORT_MAX_TRACKED_CLIENTS = 1_000;
const UNKNOWN_CLIENT = "unknown";
const OVERFLOW_CLIENT = "overflow";

const MAX_VALUE_LENGTH = 200;
const DIRECTIVE_PATTERN = /^[a-z-]{1,40}$/;
const BLOCKED_KEYWORDS = new Set(["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink"]);

export type CspViolation = Readonly<{
  directive: string;
  blocked: string;
  disposition: "enforce" | "report";
  path: string;
  source: string | null;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

function origin(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "ws:"
      ? url.origin
      : `${url.protocol}`;
  } catch {
    return null;
  }
}

function blockedResource(value: unknown): string {
  const raw = text(value);
  if (raw === null) return "unknown";
  if (BLOCKED_KEYWORDS.has(raw)) return raw;
  return origin(raw) ?? "other";
}

function pagePath(value: unknown): string {
  const raw = text(value);
  if (raw === null) return "unknown";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.pathname.slice(0, MAX_VALUE_LENGTH)
      : "unknown";
  } catch {
    return "unknown";
  }
}

function directiveName(value: unknown): string | null {
  const name = text(value);
  return name !== null && DIRECTIVE_PATTERN.test(name) ? name : null;
}

/** `violated-directive` from older browsers carries the whole directive; its name comes first. */
function violatedDirectiveName(value: unknown): string | null {
  return directiveName(text(value)?.split(" ")[0]);
}

function violation(fields: Readonly<{
  directive: unknown;
  fallbackDirective?: unknown;
  blocked: unknown;
  disposition: unknown;
  document: unknown;
  source: unknown;
}>): CspViolation | null {
  const directive = fields.directive === undefined
    ? violatedDirectiveName(fields.fallbackDirective)
    : directiveName(fields.directive);
  if (directive === null) return null;
  return {
    directive,
    blocked: blockedResource(fields.blocked),
    disposition: fields.disposition === "enforce" ? "enforce" : "report",
    path: pagePath(fields.document),
    source: origin(fields.source),
  };
}

/**
 * Accepts both shapes browsers send: the `report-uri` envelope (`{"csp-report": {...}}`) and the
 * Reporting API batch (`[{type: "csp-violation", body: {...}}]`). Anything else yields nothing.
 */
export function parseCspReport(input: unknown): CspViolation[] {
  if (isRecord(input) && isRecord(input["csp-report"])) {
    const report = input["csp-report"];
    const parsed = violation({
      directive: report["effective-directive"],
      fallbackDirective: report["violated-directive"],
      blocked: report["blocked-uri"],
      disposition: report.disposition,
      document: report["document-uri"],
      source: report["source-file"],
    });
    return parsed === null ? [] : [parsed];
  }

  if (Array.isArray(input)) {
    return input.slice(0, 20).flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "csp-violation" || !isRecord(entry.body)) return [];
      const body = entry.body;
      const parsed = violation({
        directive: body.effectiveDirective,
        blocked: body.blockedURL,
        disposition: body.disposition,
        document: body.documentURL,
        source: body.sourceFile,
      });
      return parsed === null ? [] : [parsed];
    });
  }

  return [];
}

export type CspReportSuppression = Readonly<{
  /** Dropped because their client had used its own budget for the window. */
  byClient: number;
  /** Dropped because the window's overall budget was used up. */
  byWindow: number;
}>;

export type CspReportGateDecision = Readonly<{
  log: boolean;
  /** What the previous window dropped, reported once by the first decision of the next one. */
  suppressedInPreviousWindow: CspReportSuppression | null;
}>;

/**
 * Keeps a flood of reports -- a busy page, or anyone posting to the endpoint -- from flooding the
 * log, without letting one sender use up the window: each client gets its own share of it, keyed by
 * the proxy-owned client IP (`null` when there is none). Per process, which is enough to bound
 * volume; the counts are not meant to be exact. Anything dropped is reported, so a quiet log can be
 * told apart from a saturated one.
 */
export function createCspReportLogGate({
  limit = CSP_REPORT_LOG_LIMIT,
  clientLimit = CSP_REPORT_CLIENT_LOG_LIMIT,
  windowMs = CSP_REPORT_WINDOW_MS,
  maxTrackedClients = CSP_REPORT_MAX_TRACKED_CLIENTS,
}: Readonly<{ limit?: number; clientLimit?: number; windowMs?: number; maxTrackedClients?: number }> = {}) {
  let windowStart = Number.NEGATIVE_INFINITY;
  let logged = 0;
  let perClient = new Map<string, number>();
  let byClient = 0;
  let byWindow = 0;

  return function admit(nowMs: number, client: string | null): CspReportGateDecision {
    let suppressedInPreviousWindow: CspReportSuppression | null = null;
    if (nowMs - windowStart >= windowMs) {
      if (byClient + byWindow > 0) suppressedInPreviousWindow = { byClient, byWindow };
      windowStart = nowMs;
      logged = 0;
      perClient = new Map();
      byClient = 0;
      byWindow = 0;
    }

    let key = client ?? UNKNOWN_CLIENT;
    if (!perClient.has(key) && perClient.size >= maxTrackedClients) key = OVERFLOW_CLIENT;
    const fromClient = perClient.get(key) ?? 0;
    if (fromClient >= clientLimit) {
      byClient += 1;
      return { log: false, suppressedInPreviousWindow };
    }
    if (logged >= limit) {
      byWindow += 1;
      return { log: false, suppressedInPreviousWindow };
    }
    perClient.set(key, fromClient + 1);
    logged += 1;
    return { log: true, suppressedInPreviousWindow };
  };
}
