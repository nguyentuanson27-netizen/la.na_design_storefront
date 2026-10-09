/**
 * U28 / T8 — the static gate on a checked-in GTM container export.
 *
 * The storefront may not load a container that has not been proved safe from its own artifact. This
 * module is that proof: it reads an exported container version and answers whether this exact JSON
 * may be loaded. Everything downstream — the loader, the CSP origins, preview enablement — is gated
 * on it, so it is written as a security control rather than a linter.
 *
 * Two design choices follow from that, and both are deliberate:
 *
 * **It fails closed on anything it does not understand.** Google's published export schema could not
 * be fetched in the environment this was written in, so the parser is pinned to the one export
 * format it was written against and refuses what it cannot account for at every level: a malformed
 * shape, a tag whose type it has no reviewed parser for, and — the level easiest to forget — a
 * populated top-level collection of the container version itself. A saved version carries more than
 * `tag`, `trigger` and `variable`: a `zone` links a whole child container whose tags never appear in
 * this version's `tag[]`, and `gtagConfig` carries Google tag settings that change what destinations
 * receive. Auditing only the collections this parser reads would certify an artifact by ignoring the
 * parts of it that do the delivering, so unaccounted-for collections are refused by name.
 *
 * **It keeps vendor identity all the way through.** Approval is checked field by field against the
 * vendor that field belongs to, and a Google Ads conversion is approved as a whole `(id, label)`
 * pair. Flattening the approved ids into one set would prove only that a literal appears somewhere
 * among them — not that a GA4 field names a GA4 property, or that a reviewed Ads account is
 * reporting a reviewed conversion action.
 *
 * **It collects every violation.** An operator fixing a container wants the whole list, not the
 * first problem; and a partial list invites a second review round that believes it is the last.
 *
 * **One rule is deliberately not positive proof, and it is worth naming.** The Meta scan matches
 * known markers — `fbq(`, `fbevents`, and the rest — so a Meta integration authored around them
 * would not trip it. It is a second line rather than the control: the control is the tag-type
 * allowlist, which refuses Custom HTML and every gallery template outright, and that is what a Meta
 * payload would have to arrive as. Read the Meta finding as a helpful diagnosis of *why* a tag is
 * refused, never as the reason it is safe to accept one.
 *
 * Tag Assistant is not a substitute for any of this. It observes one preview session; these rules
 * bind the artifact that will be published.
 */

import { createHash } from "node:crypto";

export const GTM_AUDIT_CODES = {
  /** The export could not be parsed as a container version at all. */
  MALFORMED_EXPORT: "MALFORMED_EXPORT",
  /** The export declares a format version this parser was not written against. */
  UNSUPPORTED_EXPORT_FORMAT: "UNSUPPORTED_EXPORT_FORMAT",
  /** A mutable workspace export, or one naming no saved version. */
  NOT_A_SAVED_VERSION: "NOT_A_SAVED_VERSION",
  /** A tag that can fire without `la_tracking_mode == live`. */
  TAG_WITHOUT_LIVE_GUARD: "TAG_WITHOUT_LIVE_GUARD",
  /** A tag type whose delivery this audit has no reviewed parser for. */
  UNAUDITABLE_TAG_TYPE: "UNAUDITABLE_TAG_TYPE",
  /** The mode variable the guards name is not a data-layer read of the application-owned fact. */
  TRACKING_MODE_VARIABLE_NOT_APP_OWNED: "TRACKING_MODE_VARIABLE_NOT_APP_OWNED",
  /** Tag sequencing gives a delivering tag a firing path this audit cannot account for. */
  TAG_SEQUENCING_NOT_AUDITABLE: "TAG_SEQUENCING_NOT_AUDITABLE",
  /** The version carries a top-level field this audit does not account for. */
  UNAUDITABLE_CONTAINER_FEATURE: "UNAUDITABLE_CONTAINER_FEATURE",
  /** The version has been deleted, so it is not an artifact that may be loaded. */
  CONTAINER_VERSION_DELETED: "CONTAINER_VERSION_DELETED",
  /** Meta belongs to the direct first-party integration, never to GTM. */
  META_TAG_PRESENT: "META_TAG_PRESENT",
  /** GA4 would send its own page view beside the application's canonical one. */
  GA4_AUTOMATIC_PAGE_VIEW: "GA4_AUTOMATIC_PAGE_VIEW",
  /** A vendor destination id the owner has not reviewed. */
  UNAPPROVED_DESTINATION: "UNAPPROVED_DESTINATION",
  /** A destination named through a variable this audit cannot resolve to a literal. */
  UNRESOLVED_DESTINATION_REFERENCE: "UNRESOLVED_DESTINATION_REFERENCE",
  /** The export came from a container the owner did not approve. */
  CONTAINER_NOT_APPROVED: "CONTAINER_NOT_APPROVED",
  /** Owner gate O4 is unresolved, so there is nothing to audit the container against. */
  NO_APPROVED_DESTINATIONS: "NO_APPROVED_DESTINATIONS",
} as const;

export type GtmAuditCode = (typeof GTM_AUDIT_CODES)[keyof typeof GTM_AUDIT_CODES];

export type GtmAuditFinding = Readonly<{
  code: GtmAuditCode;
  /** Bounded, non-secret detail: tag name and id only, never parameter payloads. */
  detail: string;
}>;

/**
 * The reviewed vendor ids, owner gate O4.
 *
 * Held as an explicit input rather than read from the environment so the audit is a pure function of
 * (artifact, approval) — the two things a reviewer must look at together.
 */
export type GtmApprovedDestinations = Readonly<{
  /** The reviewed `GTM-...` container. Binds the artifact to the container it must have come from. */
  gtmContainerId: string;
  ga4MeasurementIds: readonly string[];
  /**
   * Reviewed Google Ads conversions, as whole `(id, label)` pairs.
   *
   * The label is what names the conversion action; the id alone only names the account. Approving
   * the two separately would let a tag pair an approved id with the label of a conversion nobody
   * reviewed, so they are approved together and must match together.
   */
  googleAdsConversions: readonly Readonly<{ conversionId: string; conversionLabel: string }>[];
  tiktokPixelIds: readonly string[];
  /**
   * Custom HTML tags a person has read and approved, each pinned by the SHA-256 of its exact `html`
   * parameter. A Custom HTML tag is arbitrary script, so it is never certified by type: only these
   * exact bytes pass, and any edit — one character — makes the tag unreviewed again.
   */
  reviewedCustomHtml?: readonly Readonly<{ sha256: string }>[];
  /**
   * Gallery templates a person has read and approved. The pin is the template's full identity
   * (repository, commit, signature) AND the SHA-256 of its saved `templateData`, so a template
   * re-imported at a different version, or edited in place, is not the one that was reviewed.
   */
  reviewedGalleryTemplates?: readonly Readonly<{
    host: string;
    owner: string;
    repository: string;
    galleryTemplateId: string;
    version: string;
    signature: string;
    templateDataSha256: string;
  }>[];
}>;

export type GtmAuditResult = Readonly<{
  ok: boolean;
  findings: readonly GtmAuditFinding[];
  containerVersionId: string | null;
  containerPublicId: string | null;
}>;

/** The usage context a container must declare before the storefront may load it. */
const WEB_USAGE_CONTEXT = "web";

/**
 * Real exports spell usage contexts as upper-case enum names (`WEB`, `ANDROID_SDK_5`), while the REST
 * API and the first fixtures use `web` / `androidSdk5`. Both are the same fact, so they are compared
 * in one normalised form: lower-cased with underscores removed.
 */
function normaliseUsageContext(value: string): string {
  return value.toLowerCase().replace(/_/g, "");
}

/**
 * The usage contexts the published schema defines.
 *
 * The nested container is an approval boundary, so what it declares has to be readable in full
 * before any part of it counts as proof. `["web", 123]` must not establish a web container by
 * having the entry beside `web` quietly ignored.
 *
 * A container that declares `web` alongside another known context is still loadable in the browser:
 * usage contexts name the platforms a container serves, not exclusions. That is a policy decision
 * rather than a fact read from an artifact, and it is one to revisit against the first real export.
 */
const KNOWN_USAGE_CONTEXTS: ReadonlySet<string> = new Set(
  ["web", "android", "ios", "androidSdk5", "iosSdk5", "amp", "server"].map(normaliseUsageContext),
);

/** The container export format this parser was written against. */
const SUPPORTED_EXPORT_FORMAT_VERSION = 2;

/**
 * The top-level `containerVersion` fields this audit was written against, by exact name.
 *
 * Names, not shapes. Deciding that a field is harmless because its value happens to be a string or a
 * boolean is the same mistake as trusting a variable because of what it is called: a future
 * `runtimeMode: "live"` would be a scalar and would sail through, which is precisely the failure a
 * capability gate exists to stop. A field this audit has never heard of is refused whatever it
 * holds, because not knowing what it is *is* the problem.
 */

/** Collections this audit reads and reasons about. Every rule below speaks about these three. */
const AUDITED_CONTAINER_COLLECTIONS: ReadonlySet<string> = new Set(["tag", "trigger", "variable"]);

/**
 * Top-level collections that are accounted for and carry no runtime of their own.
 *
 * `builtInVariable` enables names, `folder` organises the workspace, and `customTemplate` is an
 * inventory: a template does nothing until a tag uses it, and a tag using one has a `cvt_*` type
 * that the reviewed-parser allowlist already refuses. They are listed so that being ignored is a
 * decision on the record rather than an oversight.
 */
const INERT_CONTAINER_COLLECTIONS: ReadonlySet<string> = new Set([
  "builtInVariable",
  "folder",
  "customTemplate",
]);

/**
 * Collections known to carry runtime or destination configuration this parser does not model.
 *
 * Named individually so a wrong *shape* on one of them reads as a malformed export rather than as an
 * unaccounted-for feature — and so the reason each is refused is written down where the next person
 * to add a parser will find it.
 */
const RUNTIME_BEARING_CONTAINER_COLLECTIONS: ReadonlySet<string> = new Set([
  // A zone links additional child containers, which may belong to another account and whose tags
  // never appear in this version's tag[]. Every rule in this module would be bypassed by one.
  "zone",
  // Google tag configuration: parameters that change what the Google tag sends and to where,
  // including automatic event and page-view behaviour, from outside any tag's own parameters.
  "gtagConfig",
  // Server-container entities. A web container should not carry them; one that does is not the
  // artifact this audit was written to read.
  "client",
  "transformation",
]);

/**
 * Scalar metadata the published schema defines, listed by exact name.
 *
 * These describe the version; none of them changes what it does at runtime — with one exception,
 * `deleted`, which is read below rather than waved past.
 */
const STRING_METADATA_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  "path",
  "accountId",
  "containerId",
  "containerVersionId",
  "name",
  "description",
  "fingerprint",
  "tagManagerUrl",
]);

const BOOLEAN_METADATA_CONTAINER_KEYS: ReadonlySet<string> = new Set(["deleted"]);

const METADATA_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  ...STRING_METADATA_CONTAINER_KEYS,
  ...BOOLEAN_METADATA_CONTAINER_KEYS,
]);

/** The application-owned dataLayer fact every production tag must be gated on. */
const TRACKING_MODE_VARIABLE = "la_tracking_mode";
const LIVE_MODE = "live";

/**
 * The GTM variable type that reads a value out of the dataLayer.
 *
 * The guard is only worth anything if the thing it reads is the fact the application pushes. A
 * variable merely *named* `la_tracking_mode` proves nothing: a Constant (`c`) or a Custom
 * JavaScript variable (`jsm`) of that name could return `live` unconditionally, and then every
 * production tag would satisfy the static check while preview sessions saw `live` too and shipped
 * real traffic. Preview isolation has to be mechanical, so the variable type is checked, not the
 * name.
 */
const DATA_LAYER_VARIABLE_TYPE = "v";

/**
 * Tag types that carry no vendor delivery of their own.
 *
 * Kept deliberately small. Everything absent from it — including a type this list has never seen —
 * is treated as a production destination and must prove its guard.
 */
const NON_DELIVERING_TAG_TYPES: ReadonlySet<string> = new Set([
  // Google's conversion linker only writes first-party cookies; it delivers no measurement itself.
  "gclidw",
]);

/**
 * Tag types whose delivery this audit has a reviewed parser for.
 *
 * A type earns a place here only when the type itself fixes the vendor, so the parameters that can
 * name a destination are bounded and readable from the export alone. Google's built-in tags qualify.
 *
 * A Custom HTML tag does not, and no parameter allowlist can rescue it: its payload is arbitrary
 * script, so a production endpoint can sit under any key or behind a variable reference, with no
 * recognised destination key anywhere on the tag.
 *
 * A gallery template does not either, but for a different reason, and the distinction matters. The
 * saved version *does* carry the template — `containerVersion.customTemplate[]` holds each one's
 * `templateData` and, for gallery templates, a `galleryReference` naming its owner, repository,
 * version and signature. What is missing is not the code but the review: this audit has no parser
 * bound to any specific template, so it cannot say which of a template's parameters names a
 * destination. Certifying such a tag because it carries a live guard would confuse *when* it fires
 * with *where* it delivers, so it is refused.
 *
 * The consequence is deliberate and worth stating: delivering TikTok through its gallery template
 * cannot be certified by this audit as written. Under the locked v1 contract — plan §3.7, *TikTok
 * Pixel runs through GTM* — the only path that admits it is a parser bound to that exact template,
 * identified from a real saved export: its `galleryReference` and a checksum over its
 * `templateData`, reviewed by a person, before any mapping of Pixel ID or event fields is written.
 * Guessing the `cvt_*` type-to-template mapping from a fixture is exactly what that review exists to
 * prevent. Delivering TikTok outside GTM is not an alternative available here: that is an
 * architecture change needing its own approved amendment, not something this gate may open.
 */
const REVIEWED_TAG_TYPES: ReadonlySet<string> = new Set([
  "gclidw", // Conversion Linker — first-party cookies only
  "gaawc", // GA4 Configuration, the legacy name for the Google tag
  "googtag", // Google tag
  "gaawe", // GA4 event
  "awct", // Google Ads Conversion Tracking
]);

/**
 * Parameter keys that name a vendor destination, grouped by the vendor whose namespace they belong
 * to.
 *
 * The grouping is the point. Checking every id against one flat union proves only that a literal
 * appears somewhere in the approved set — not that a GA4 field names a GA4 property or that an Ads
 * field names an Ads conversion. A tag pairing an approved TikTok pixel id with a GA4 parameter
 * would satisfy a union and satisfies nothing here.
 */
const GA4_DESTINATION_KEYS: readonly string[] = ["measurementId", "measurementIdOverride", "tagId"];
const ADS_CONVERSION_ID_KEY = "conversionId";
const ADS_CONVERSION_LABEL_KEY = "conversionLabel";
/** `pixelId` is the generic spelling; `pixel_code` is what the reviewed TikTok Pixel template uses. */
const TIKTOK_DESTINATION_KEYS: readonly string[] = ["pixelId", "pixel_code"];

const ALL_DESTINATION_KEYS: ReadonlySet<string> = new Set([
  ...GA4_DESTINATION_KEYS,
  ADS_CONVERSION_ID_KEY,
  ADS_CONVERSION_LABEL_KEY,
  ...TIKTOK_DESTINATION_KEYS,
]);

/** Which vendor's destination fields each reviewed tag type is allowed to carry. */
const ADS_ACCOUNT_PREFIX = "AW-";

function stripAdsAccountPrefix(id: string): string {
  return id.startsWith(ADS_ACCOUNT_PREFIX) ? id.slice(ADS_ACCOUNT_PREFIX.length) : id;
}

const GA4_TAG_TYPES: ReadonlySet<string> = new Set(["gaawc", "googtag", "gaawe"]);
const ADS_TAG_TYPES: ReadonlySet<string> = new Set(["awct"]);

/**
 * Parameter keys that carry a Google tag's configuration settings.
 *
 * Only these are followed when looking for the page-view toggle. Following every reference on the
 * tag was a fail-open: an unrelated variable that happened to hold `send_page_view = false` proved
 * the toggle off for a tag that never wired it as configuration settings at all.
 */
const CONFIGURATION_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "configSettingsTable",
  "configSettingsVariable",
]);

/**
 * Tag types that configure a Google destination and can therefore emit an automatic page view.
 *
 * `gaawc` is the legacy GA4 Configuration tag; `googtag` is the Google tag it became. Both are
 * listed because an export may predate the upgrade.
 */
const GOOGLE_CONFIGURATION_TAG_TYPES: ReadonlySet<string> = new Set(["gaawc", "googtag"]);

/** How the page-view toggle is spelled across the tag, its settings table and a settings variable. */
const PAGE_VIEW_KEYS: ReadonlySet<string> = new Set(["sendPageView", "send_page_view"]);

/** Substrings that mark a tag as a Meta integration however it was authored. */
const META_MARKERS = ["facebook", "meta_pixel", "metapixel", "fbq(", "fbevents", "connect.facebook"];

type Parameter = Readonly<{ key?: unknown; value?: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readParameters(value: unknown): readonly Parameter[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parameterValue(parameters: readonly Parameter[], key: string): string | null {
  for (const parameter of parameters) {
    if (readString(parameter.key) === key) return readString(parameter.value);
  }
  return null;
}

/**
 * Whether the container's `la_tracking_mode` variable really is the application's dataLayer fact.
 *
 * This is what makes every firing guard mean anything. The guards name a variable; without this,
 * naming is all they prove. The variable must exist exactly once, be a Data Layer Variable, and
 * read exactly the `la_tracking_mode` key — anything else, including a Constant or a computed
 * variable that happens to return `live`, would let preview sessions satisfy the same guard as
 * production.
 */
function trackingModeVariableIsAppOwned(variables: VariableIndex): boolean {
  const variable = variables.get(TRACKING_MODE_VARIABLE);
  if (variable === undefined) return false;
  if (!isRecord(variable.source)) return false;
  if (readString(variable.source.type) !== DATA_LAYER_VARIABLE_TYPE) return false;

  // A Data Layer Variable names the key it reads in its `name` parameter, which need not match the
  // variable's own name.
  const dataLayerKey = parameterValue(readParameters(variable.source.parameter), "name");
  return dataLayerKey === TRACKING_MODE_VARIABLE;
}

/**
 * Whether this trigger admits only `la_tracking_mode == live`.
 *
 * The condition must be an equality on the mode variable against exactly `live`. A trigger with no
 * conditions, or whose conditions name something else, does not constrain the mode and so cannot
 * carry the guard.
 */
function triggerCarriesLiveGuard(trigger: Record<string, unknown>): boolean {
  const conditions = [
    ...(Array.isArray(trigger.filter) ? trigger.filter : []),
    ...(Array.isArray(trigger.customEventFilter) ? trigger.customEventFilter : []),
  ].filter(isRecord);

  return conditions.some((condition) => {
    if (readString(condition.type)?.toLowerCase() !== "equals") return false;
    const parameters = readParameters(condition.parameter);
    const left = parameterValue(parameters, "arg0");
    const right = parameterValue(parameters, "arg1");
    // The left side must *be* a reference to the mode variable, not merely text that looks like its
    // name once braces are stripped. A bare literal `la_tracking_mode` is a constant string GTM
    // would compare against "live" and never match, so a guard read that loosely is not the guard
    // the container actually has.
    return (
      left !== null
      && right === LIVE_MODE
      && referencedVariableName(left) === TRACKING_MODE_VARIABLE
    );
  });
}

/**
 * Every string anywhere inside a tag, however deeply nested.
 *
 * GTM nests real payloads inside `LIST` and `MAP` parameters, and a custom template can bury a
 * vendor snippet or a destination id several levels down. A scan that read only top-level parameter
 * values would wave exactly the tags this audit most needs to catch, so both the Meta check and the
 * destination check walk the whole subtree.
 *
 * The walk is depth-bounded because the input is untrusted JSON: a self-referential or pathological
 * structure must not be able to hang the audit. Reaching the bound is itself suspicious, so the
 * caller treats it as a parse failure rather than a clean result.
 */
const MAX_PARAMETER_DEPTH = 32;

function collectStrings(
  value: unknown,
  depth = 0,
  found: { truncated: boolean } = { truncated: false },
): Readonly<{ strings: string[]; truncated: boolean }> {
  if (depth > MAX_PARAMETER_DEPTH) {
    found.truncated = true;
    return { strings: [], truncated: true };
  }

  const strings: string[] = [];
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) {
    for (const entry of value) strings.push(...collectStrings(entry, depth + 1, found).strings);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      strings.push(...collectStrings(entry, depth + 1, found).strings);
    }
  }
  return { strings, truncated: found.truncated };
}

/** Every `key`/`value` pair anywhere inside a tag's parameters, however deeply nested. */
function collectKeyedValues(value: unknown, depth = 0): Array<readonly [string, string]> {
  if (depth > MAX_PARAMETER_DEPTH) return [];
  const pairs: Array<readonly [string, string]> = [];
  if (Array.isArray(value)) {
    for (const entry of value) pairs.push(...collectKeyedValues(entry, depth + 1));
  } else if (isRecord(value)) {
    const key = readString(value.key);
    const literal = readString(value.value);
    if (key !== null && literal !== null) pairs.push([key, literal]);
    for (const entry of Object.values(value)) pairs.push(...collectKeyedValues(entry, depth + 1));
  }
  return pairs;
}

/**
 * Every `MAP` row inside a parameter tree, each row kept as its own key→value table.
 *
 * Row identity is the point. A settings table spells one setting as two cells — `parameter` naming
 * it and `parameterValue` holding its value — so a scan that flattens the tree into loose pairs can
 * pair the name from one row with the value from another. That is not a cosmetic loss: it lets a row
 * asserting `send_page_view = true` be "proved" false by an unrelated row that happens to say false.
 * Rows are therefore read as rows, and a claim is only ever read from the row that makes it.
 */
function collectMapRows(value: unknown, depth = 0): Array<ReadonlyMap<string, string>> {
  if (depth > MAX_PARAMETER_DEPTH) return [];
  const rows: Array<ReadonlyMap<string, string>> = [];
  if (Array.isArray(value)) {
    for (const entry of value) rows.push(...collectMapRows(entry, depth + 1));
  } else if (isRecord(value)) {
    if (Array.isArray(value.map)) {
      const row = new Map<string, string>();
      for (const cell of value.map) {
        if (!isRecord(cell)) continue;
        const key = readString(cell.key);
        const literal = readString(cell.value);
        if (key !== null && literal !== null) row.set(key, literal);
      }
      if (row.size > 0) rows.push(row);
    }
    for (const entry of Object.values(value)) rows.push(...collectMapRows(entry, depth + 1));
  }
  return rows;
}

/**
 * Whether any `MAP` row in this tree declares one cell key twice.
 *
 * `collectMapRows` builds each row as a key→value table, so a repeated key silently keeps the last
 * cell — and a settings row saying `parameterValue: "true"` and then `parameterValue: "false"` would
 * prove page views disabled by the order its cells happen to be written in. A row that says two
 * things about one key says nothing about it, so ambiguity is refused rather than resolved.
 */
function mapRowRepeatsAKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_PARAMETER_DEPTH) return false;
  if (Array.isArray(value)) return value.some((entry) => mapRowRepeatsAKey(entry, depth + 1));
  if (!isRecord(value)) return false;

  if (Array.isArray(value.map)) {
    const seen = new Set<string>();
    for (const cell of value.map) {
      if (!isRecord(cell)) continue;
      const key = readString(cell.key);
      if (key === null) continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return Object.values(value).some((entry) => mapRowRepeatsAKey(entry, depth + 1));
}

/**
 * The container's variables, indexed by the name a `{{reference}}` uses.
 *
 * Only constant variables resolve to a literal. Anything computed — a JavaScript variable, a lookup
 * table, a data-layer read — cannot be evaluated statically, so it stays unresolved and any
 * destination that depends on it is refused rather than assumed approved.
 */
type VariableIndex = ReadonlyMap<string, Readonly<{ literal: string | null; source: unknown }>>;

const VARIABLE_REFERENCE = /^\{\{(.+)\}\}$/;
const EMBEDDED_VARIABLE_REFERENCE = /\{\{([^{}]+)\}\}/g;

/** The variable a value names outright. A destination id must *be* the reference, not contain one. */
function referencedVariableName(value: string): string | null {
  return VARIABLE_REFERENCE.exec(value.trim())?.[1]?.trim() ?? null;
}

/**
 * Every variable a value mentions, including references embedded in a larger string.
 *
 * A snippet reads `<script>{{Meta snippet}}</script>`, not `{{Meta snippet}}`, so a whole-string
 * match would follow none of the references that actually carry a payload.
 */
function embeddedVariableNames(value: string): string[] {
  return [...value.matchAll(EMBEDDED_VARIABLE_REFERENCE)].map((match) => match[1]!.trim());
}

function indexVariables(variables: readonly unknown[]): VariableIndex {
  const index = new Map<string, { literal: string | null; source: unknown }>();
  for (const candidate of variables) {
    if (!isRecord(candidate)) continue;
    const name = readString(candidate.name);
    if (name === null) continue;

    const parameters = readParameters(candidate.parameter);
    const rawValue = readString(candidate.type) === "c" ? parameterValue(parameters, "value") : null;
    // A constant whose value is itself a reference is not a literal this audit can stand behind.
    const literal = rawValue !== null && referencedVariableName(rawValue) === null ? rawValue : null;

    // Uniqueness of the name is established structurally, before this index is built, so a lookup
    // here resolves to the one definition a reviewer would have read.
    index.set(name, { literal, source: candidate });
  }
  return index;
}

/**
 * Every string the tag would deliver, following variable references transitively.
 *
 * A tag can hold nothing but `{{Meta snippet}}` and still ship a Meta pixel, because the snippet
 * lives in the variable. Scanning the tag object alone would read the reference and never the
 * payload, so the walk follows each reference into the variable it names. Visited names are
 * remembered: container variables may reference one another, and a cycle must not hang the audit.
 */
function payloadStrings(
  tag: Record<string, unknown>,
  variables: VariableIndex,
): Readonly<{ strings: string[]; truncated: boolean }> {
  const own = collectStrings(tag);
  const strings = [...own.strings];
  let truncated = own.truncated;

  const visited = new Set<string>();
  const pending = [...own.strings];
  while (pending.length > 0) {
    const value = pending.pop()!;
    for (const name of embeddedVariableNames(value)) {
      if (visited.has(name)) continue;
      visited.add(name);
      const variable = variables.get(name);
      if (variable === undefined) continue;
      const nested = collectStrings(variable.source);
      truncated ||= nested.truncated;
      strings.push(...nested.strings);
      pending.push(...nested.strings);
    }
  }

  return { strings, truncated };
}

function tagIsMeta(tag: Record<string, unknown>, variables: VariableIndex): boolean {
  const haystack = payloadStrings(tag, variables).strings.join(" ").toLowerCase();
  return META_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * The literals a given destination key carries on this tag, resolved through the container's
 * variables.
 *
 * A `{{reference}}` is followed rather than skipped. Skipping it was a fail-open: a live-guarded tag
 * could name `{{Production GA4 ID}}`, the literal would never appear on the tag, and the approval
 * check would have nothing to compare. A reference that cannot be resolved to a literal is reported
 * as unresolved so the artifact is refused instead of quietly certified.
 */
function destinationValues(
  tag: Record<string, unknown>,
  key: string,
  variables: VariableIndex,
): Readonly<{ resolved: string[]; unresolved: string[] }> {
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const [candidateKey, value] of collectKeyedValues(tag.parameter)) {
    if (candidateKey !== key || value.length === 0) continue;

    const reference = referencedVariableName(value);
    if (reference === null) {
      resolved.push(value);
      continue;
    }

    const literal = variables.get(reference)?.literal ?? null;
    if (literal === null) unresolved.push(reference);
    else resolved.push(literal);
  }

  return { resolved, unresolved };
}

/** Every destination key this tag actually carries, whatever vendor it belongs to. */
function destinationKeysPresent(tag: Record<string, unknown>): Set<string> {
  const present = new Set<string>();
  for (const [key, value] of collectKeyedValues(tag.parameter)) {
    if (ALL_DESTINATION_KEYS.has(key) && value.length > 0) present.add(key);
  }
  return present;
}

/**
 * Whether this Google configuration tag positively proves it sends no page view.
 *
 * Positive proof is the requirement, not the absence of a contrary signal: the application owns the
 * canonical page view, and the toggle now lives inside configuration settings or a referenced
 * settings variable rather than on the tag. A tag whose settings this audit cannot read therefore
 * cannot be shown to be safe, and is refused.
 */
function provesPageViewsDisabled(tag: Record<string, unknown>, variables: VariableIndex): boolean {
  const parameters = readParameters(tag.parameter);
  const claims: string[] = [];

  // The legacy direct toggle, read only from the tag's own top-level parameters.
  for (const parameter of parameters) {
    const key = readString(parameter.key);
    if (key !== null && PAGE_VIEW_KEYS.has(key)) claims.push(readString(parameter.value) ?? "");
  }

  // Configuration settings: the inline table, and the variable the tag names as its settings
  // carrier. Nothing else is followed, so an unrelated variable that happens to hold the toggle
  // cannot answer for a tag that never wired it.
  for (const parameter of parameters) {
    const key = readString(parameter.key);
    if (key === null || !CONFIGURATION_SETTINGS_KEYS.has(key)) continue;

    const settings: unknown[] = [parameter];
    const named = readString(parameter.value);
    const reference = named === null ? null : referencedVariableName(named);
    const carrier = reference === null ? undefined : variables.get(reference);
    if (carrier !== undefined) settings.push(carrier.source);

    for (const source of settings) {
      for (const row of collectMapRows(source)) {
        // The settings table spells one setting as two cells, `parameter` naming it and
        // `parameterValue` holding its value. A row naming the toggle and then saying nothing about
        // it is an open question, and says so as an empty claim.
        const setting = row.get("parameter");
        if (setting !== undefined && PAGE_VIEW_KEYS.has(setting)) {
          claims.push(row.get("parameterValue") ?? "");
        }
        // Some shapes spell the same row as a direct key instead.
        for (const spelling of PAGE_VIEW_KEYS) {
          const direct = row.get(spelling);
          if (direct !== undefined) claims.push(direct);
        }
      }
    }
  }

  // Proof, not the absence of a contrary signal: something must assert the toggle, and nothing may
  // contradict it. A tag that claims both `true` and `false` has not been shown to be safe.
  return claims.length > 0 && claims.every((value) => value === "false");
}

function isGoogleConfigurationTag(tag: Record<string, unknown>): boolean {
  return GOOGLE_CONFIGURATION_TAG_TYPES.has(readString(tag.type) ?? "");
}

/**
 * Whether the version's shape matches the schema, field by field and element by element.
 *
 * Knowing a field's name and that its outer value is an array is not knowing that the artifact is
 * well formed — it is the same substitution of a proxy for the thing that this module has had to be
 * corrected on repeatedly. `deleted: "true"` is not a boolean, so the deleted check would miss it;
 * a `trigger` array holding a string would be quietly filtered away by the readers below, and a
 * malformed entry that becomes an ignored entry is exactly how an artifact gets certified for what
 * it does not contain.
 *
 * So malformed data is refused here rather than normalised away, and the semantic rules run only on
 * a version whose shape has been established.
 */
function validateContainerVersionShape(
  version: Record<string, unknown>,
  refuse: (code: GtmAuditCode, detail: string) => void,
): boolean {
  const before = { malformed: false };
  const malformed = (detail: string) => {
    before.malformed = true;
    refuse(GTM_AUDIT_CODES.MALFORMED_EXPORT, detail);
  };

  // JSON has no `undefined`: a field is present with a value or it is absent, and an absent field is
  // the responsibility of whichever rule needs it rather than of shape validation.
  const declared = (key: string) => key in version && version[key] !== undefined;

  for (const key of STRING_METADATA_CONTAINER_KEYS) {
    if (declared(key) && readString(version[key]) === null) {
      malformed(`containerVersion.${key} is not a string`);
    }
  }
  for (const key of BOOLEAN_METADATA_CONTAINER_KEYS) {
    if (declared(key) && typeof version[key] !== "boolean") {
      malformed(`containerVersion.${key} is not a boolean`);
    }
  }

  // Every collection the schema defines holds objects. An entry that is not one cannot be read, and
  // skipping it would let the audit report on a subset of the artifact as if it were the whole.
  for (const key of [...AUDITED_CONTAINER_COLLECTIONS, ...INERT_CONTAINER_COLLECTIONS]) {
    const value = version[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) continue; // Reported by the capability gate.
    if (!value.every(isRecord)) malformed(`containerVersion.${key} holds an entry that is not an object`);
  }

  // Trigger identity. The guarded-trigger set is keyed by `triggerId`, so an id naming two triggers
  // makes "guarded" ambiguous: the definition carrying the live filter would vouch for the one that
  // does not. An id has to identify exactly one trigger before it can be used as a security fact.
  const triggers = version.trigger;
  if (Array.isArray(triggers)) {
    const seen = new Set<string>();
    for (const trigger of triggers) {
      if (!isRecord(trigger)) continue; // Reported by the element check above.
      const id = readString(trigger.triggerId);
      if (id === null || id.length === 0) {
        malformed("containerVersion.trigger holds an entry with no usable triggerId");
        continue;
      }
      if (seen.has(id)) {
        malformed(`containerVersion.trigger declares triggerId "${id}" more than once`);
      }
      seen.add(id);
    }
  }

  // Variable identity. `{{reference}}` resolves by name, so a name declared twice leaves every
  // consumer free to read whichever definition the index happened to keep — one definition proving a
  // destination approved while another names an unreviewed one, or one settings variable answering
  // for another. Google's own model makes `variableId` the identity and `name` a display name; since
  // this audit must resolve by name, the name has to identify exactly one variable before any
  // reference to it can prove anything.
  const variables = version.variable;
  if (Array.isArray(variables)) {
    const seen = new Set<string>();
    for (const variable of variables) {
      if (!isRecord(variable)) continue; // Reported by the element check above.
      const name = readString(variable.name);
      if (name === null || name.length === 0) {
        malformed("containerVersion.variable holds an entry with no usable name");
        continue;
      }
      if (seen.has(name)) {
        malformed(`containerVersion.variable declares the name "${name}" more than once`);
      }
      seen.add(name);
    }
  }

  // Firing references. Filtering out an entry that is not a string would be malformed data becoming
  // ignored data at the exact point where the audit decides whether a tag is guarded. (Only firing
  // triggers are read: a blocking trigger can remove a firing, never add one.)
  const tags = version.tag;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!isRecord(tag)) continue; // Reported by the element check above.
      const firing = tag.firingTriggerId;
      if (firing === undefined) continue;
      const label = readString(tag.name) ?? "unnamed";
      if (!Array.isArray(firing)) {
        malformed(`${label}: firingTriggerId is not an array`);
        continue;
      }
      if (!firing.every((entry) => (readString(entry) ?? "").length > 0)) {
        malformed(`${label}: firingTriggerId holds an entry that is not a non-empty string`);
      }
    }
  }

  // Tag identity. Sequencing edges name their partner by `tagName`, so a name has to identify one
  // tag before an edge through it can be reasoned about — and an edge naming no tag in this version
  // is a reference the audit cannot follow, which is refused rather than passed over.
  if (Array.isArray(tags)) {
    const tagNames = new Set<string>();
    for (const tag of tags) {
      if (!isRecord(tag)) continue; // Reported by the element check above.
      const name = readString(tag.name);
      if (name === null || name.length === 0) {
        malformed("containerVersion.tag holds an entry with no usable name");
        continue;
      }
      if (tagNames.has(name)) {
        malformed(`containerVersion.tag declares the name "${name}" more than once`);
      }
      tagNames.add(name);
    }

    for (const tag of tags) {
      if (!isRecord(tag)) continue;
      const label = readString(tag.name) ?? "unnamed";
      for (const key of ["setupTag", "teardownTag"]) {
        const edges = tag[key];
        if (edges === undefined) continue;
        if (!Array.isArray(edges)) {
          malformed(`${label}: ${key} is not an array`);
          continue;
        }
        for (const edge of edges) {
          const named = isRecord(edge) ? readString(edge.tagName) : null;
          if (named === null || named.length === 0 || !tagNames.has(named)) {
            malformed(`${label}: ${key} names no tag in this version`);
          }
        }
      }
    }
  }

  // Parameter rows. Checked across tags and variables alike, because both are read as row tables.
  for (const collection of [tags, version.variable]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!isRecord(entry)) continue;
      if (mapRowRepeatsAKey(entry.parameter)) {
        malformed(`${readString(entry.name) ?? "unnamed"}: a parameter row declares one key twice`);
      }
    }
  }

  // The container the artifact claims to come from is what binds it to the owner's approval, so its
  // own shape has to hold up before that binding means anything.
  if (declared("container")) {
    const container = version.container;
    if (!isRecord(container)) malformed("containerVersion.container is not an object");
    else {
      if (readString(container.publicId) === null) {
        malformed("containerVersion.container.publicId is not a string");
      }

      if (container.usageContext !== undefined) {
        const contexts = container.usageContext;
        if (!Array.isArray(contexts)) {
          malformed("containerVersion.container.usageContext is not an array");
        } else if (!contexts.every((entry) => KNOWN_USAGE_CONTEXTS.has(normaliseUsageContext(readString(entry) ?? "")))) {
          malformed("containerVersion.container.usageContext holds an entry this audit cannot read");
        }
      }
      // A version and the container it names must agree about which container that is.
      for (const key of ["accountId", "containerId"]) {
        const outer = readString(version[key]);
        const inner = readString(container[key]);
        if (outer !== null && inner !== null && outer !== inner) {
          malformed(`containerVersion.${key} and containerVersion.container.${key} disagree`);
        }
      }
    }
  }

  return !before.malformed;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const TTQ_LOAD_ID = /ttq\.load\(\s*['"]([^'"]+)['"]/g;

/** The pixel ids a TikTok snippet loads, read from its `ttq.load('<id>')` calls. */
function tiktokLoadedIds(html: string): string[] {
  return [...html.matchAll(TTQ_LOAD_ID)].map((match) => match[1]!);
}

/**
 * The exact `html` of a Custom HTML tag, but only when the tag carries nothing else that could
 * change what runs: just `html` and a `supportDocumentWrite` that is not enabled.
 */
function customHtmlOf(tag: Record<string, unknown>): string | null {
  const parameters = readParameters(tag.parameter);
  const allowedKeys = new Set(["html", "supportDocumentWrite"]);
  if (parameters.some((parameter) => !allowedKeys.has(readString(parameter.key) ?? ""))) return null;
  if (parameterValue(parameters, "supportDocumentWrite") === "true") return null;
  return parameterValue(parameters, "html");
}

export function auditGtmContainerExport({
  source,
  approved,
}: Readonly<{
  source: unknown;
  approved: GtmApprovedDestinations;
}>): GtmAuditResult {
  const findings: GtmAuditFinding[] = [];
  const refuse = (code: GtmAuditCode, detail: string) => findings.push(Object.freeze({ code, detail }));

  const approvedGa4 = new Set(approved.ga4MeasurementIds);
  const approvedTiktok = new Set(approved.tiktokPixelIds);
  const approvedAdsPairs = new Set(
    approved.googleAdsConversions.map((pair) => `${pair.conversionId}\u0000${pair.conversionLabel}`),
  );
  const approvedAdsIds = new Set(approved.googleAdsConversions.map((pair) => pair.conversionId));
  // A Google tag names its destination in `tagId`, which is a GA4 property (`G-…`) or a Google Ads
  // account (`AW-…`). The Ads conversion tag carries the same account without the prefix, so the
  // account is compared in its bare form.
  const approvedAdsAccounts = new Set(
    approved.googleAdsConversions.map((pair) => stripAdsAccountPrefix(pair.conversionId)),
  );

  const reviewedHtmlHashes = new Set((approved.reviewedCustomHtml ?? []).map((pin) => pin.sha256));
  const reviewedTemplates = approved.reviewedGalleryTemplates ?? [];

  if (approvedGa4.size + approvedAdsPairs.size + approvedTiktok.size === 0) {
    // Owner gate O4. Passing here would certify a container against no reviewed destination at all.
    refuse(
      GTM_AUDIT_CODES.NO_APPROVED_DESTINATIONS,
      "no reviewed vendor destination ids were supplied (owner gate O4)",
    );
  }

  // The parser was written against one export format. A different one may spell the same fields
  // differently, so it is refused rather than read hopefully.
  const declaredFormat = isRecord(source) ? source.exportFormatVersion : undefined;
  if (declaredFormat !== SUPPORTED_EXPORT_FORMAT_VERSION) {
    refuse(
      GTM_AUDIT_CODES.UNSUPPORTED_EXPORT_FORMAT,
      `export declares format version ${JSON.stringify(declaredFormat) ?? "none"}; this audit reads only version ${SUPPORTED_EXPORT_FORMAT_VERSION}`,
    );
  }

  const version = isRecord(source) ? source.containerVersion : undefined;
  if (!isRecord(version)) {
    refuse(GTM_AUDIT_CODES.MALFORMED_EXPORT, "export has no containerVersion object");
    return Object.freeze({
      ok: false,
      findings: Object.freeze(findings),
      containerVersionId: null,
      containerPublicId: null,
    });
  }

  const tags = version.tag;
  const triggers = version.trigger;
  if (!Array.isArray(tags) || !Array.isArray(triggers)) {
    refuse(GTM_AUDIT_CODES.MALFORMED_EXPORT, "containerVersion has no tag/trigger arrays");
    return Object.freeze({
      ok: false,
      findings: Object.freeze(findings),
      containerVersionId: null,
      containerPublicId: null,
    });
  }

  // The capability gate. A rule that reads three collections cannot speak for a version that has
  // more than three, so every top-level field is matched against the schema this audit was written
  // against, by exact name. Anything else refuses the artifact whatever it holds — a field nobody
  // has reviewed is not made safe by being a boolean.
  for (const [key, value] of Object.entries(version)) {
    if (key === "container" || METADATA_CONTAINER_KEYS.has(key)) continue;

    const isKnownCollection =
      AUDITED_CONTAINER_COLLECTIONS.has(key)
      || INERT_CONTAINER_COLLECTIONS.has(key)
      || RUNTIME_BEARING_CONTAINER_COLLECTIONS.has(key);
    if (!isKnownCollection) {
      refuse(
        GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE,
        `containerVersion.${key} is not part of the schema this audit was written against`,
      );
      continue;
    }

    // Shape is checked for every known collection, inert ones included: an inventory that is not a
    // list is not an inventory, and reading it as absent is a guess.
    if (!Array.isArray(value)) {
      refuse(GTM_AUDIT_CODES.MALFORMED_EXPORT, `containerVersion.${key} is not an array`);
      continue;
    }

    if (RUNTIME_BEARING_CONTAINER_COLLECTIONS.has(key) && value.length > 0) {
      refuse(
        GTM_AUDIT_CODES.UNAUDITABLE_CONTAINER_FEATURE,
        `containerVersion.${key} is populated and this audit does not model it`,
      );
    }
  }

  // Shape before meaning. A field whose type does not match the schema cannot be read for what it
  // says, and reading it anyway is how malformed data becomes ignored data.
  const shapeIsValid = validateContainerVersionShape(version, refuse);

  // A deleted version is not an artifact that may be loaded, whatever its contents say. The question
  // this module answers is whether *this exact JSON* may be published, and a deleted one may not.
  if (version.deleted === true) {
    refuse(
      GTM_AUDIT_CODES.CONTAINER_VERSION_DELETED,
      "the export names a deleted container version",
    );
  }

  if (!shapeIsValid) {
    // The capability and format findings above stand on their own; the semantic rules would be
    // reporting on a version this audit has just said it cannot read.
    return Object.freeze({
      ok: false,
      findings: Object.freeze(findings),
      containerVersionId: readString(version.containerVersionId),
      containerPublicId: isRecord(version.container)
        ? readString(version.container.publicId)
        : null,
    });
  }

  const containerVersionId = readString(version.containerVersionId);
  const containerPublicId = isRecord(version.container)
    ? readString(version.container.publicId)
    : null;

  // Bind the artifact to the reviewed container. Without this, an export from a different container
  // that happened to reuse the same destination ids would certify just as cleanly.
  if (containerPublicId !== approved.gtmContainerId) {
    refuse(
      GTM_AUDIT_CODES.CONTAINER_NOT_APPROVED,
      "export does not come from the owner-approved GTM container",
    );
  }

  // The question is whether this artifact may be loaded *by the storefront*, so the container has to
  // be a web container. A server container's export would otherwise satisfy every rule here and be
  // certified for a runtime it was never built for. Proof is required rather than assumed: a
  // container that does not say it is a web container has not been shown to be one.
  //
  // This is the one rule written against a resource shape no export in this repository has ever
  // exhibited, because there is no real export yet. If the first genuine saved version turns out not
  // to carry `usageContext` on its nested container, this refusal is where that will surface — which
  // is the right place for it, with a person reading the finding.
  const usageContext = isRecord(version.container) ? version.container.usageContext : undefined;
  const declaresWebContext =
    Array.isArray(usageContext)
    && usageContext.some((entry) => normaliseUsageContext(readString(entry) ?? "") === WEB_USAGE_CONTEXT);
  if (!declaresWebContext) {
    refuse(
      GTM_AUDIT_CODES.CONTAINER_NOT_APPROVED,
      `export does not prove its container is a ${WEB_USAGE_CONTEXT} container`,
    );
  }

  // The gate above already refuses an unreadable variable list; indexing defends itself so that a
  // refused artifact still produces the rest of its findings in the same pass.
  const variables = indexVariables(Array.isArray(version.variable) ? version.variable : []);

  // A workspace export carries no saved version, and "0" is the placeholder an unsaved export uses.
  if (containerVersionId === null || containerVersionId === "" || containerVersionId === "0") {
    refuse(
      GTM_AUDIT_CODES.NOT_A_SAVED_VERSION,
      "export names no saved container version; a mutable workspace export may not be published",
    );
  }

  // The guards name a variable; whether that variable is the application's fact is a property of the
  // container, checked once. If it is not, no trigger in this container can carry a guard, so the
  // guarded set is emptied rather than left to certify tags on a name match.
  const modeVariableIsAppOwned = trackingModeVariableIsAppOwned(variables);
  if (!modeVariableIsAppOwned) {
    refuse(
      GTM_AUDIT_CODES.TRACKING_MODE_VARIABLE_NOT_APP_OWNED,
      `${TRACKING_MODE_VARIABLE} is not a single Data Layer Variable reading the ${TRACKING_MODE_VARIABLE} key, so no firing guard built on it can be trusted`,
    );
  }

  // Tag sequencing is a firing path that never passes through a tag's own firingTriggerId: a setup
  // tag runs before its primary and a cleanup tag after it. A delivering tag on either end of such
  // an edge can therefore execute without its own live trigger ever being evaluated. This audit does
  // not model that graph — the export format was never read from primary documentation — so it
  // refuses delivering tags that take part in sequencing rather than guessing at the semantics.
  const sequencedTagNames = new Set<string>();
  for (const candidate of tags) {
    if (!isRecord(candidate)) continue;
    for (const key of ["setupTag", "teardownTag"]) {
      const edges = candidate[key];
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        if (!isRecord(edge)) continue;
        const named = readString(edge.tagName);
        if (named !== null) sequencedTagNames.add(named);
      }
    }
  }

  // Gallery templates this container carries that match a reviewed pin exactly, by the tag type they
  // register (`cvt_<galleryTemplateId>`). A template whose identity or bytes differ from the pin is
  // simply absent here, so every tag of its type falls back to being refused.
  const pinnedTemplateTagTypes = new Set<string>();
  const containerTemplates = Array.isArray(version.customTemplate) ? version.customTemplate : [];
  for (const template of containerTemplates) {
    if (!isRecord(template) || !isRecord(template.galleryReference)) continue;
    const reference = template.galleryReference;
    const templateData = readString(template.templateData);
    if (templateData === null) continue;
    const digest = sha256Hex(templateData);
    const matches = reviewedTemplates.some(
      (pin) =>
        pin.host === readString(reference.host)
        && pin.owner === readString(reference.owner)
        && pin.repository === readString(reference.repository)
        && pin.galleryTemplateId === readString(reference.galleryTemplateId)
        && pin.version === readString(reference.version)
        && pin.signature === readString(reference.signature)
        && pin.templateDataSha256 === digest,
    );
    const galleryTemplateId = readString(reference.galleryTemplateId);
    if (matches && galleryTemplateId !== null) pinnedTemplateTagTypes.add(`cvt_${galleryTemplateId}`);
  }

  const guardedTriggerIds = modeVariableIsAppOwned ? new Set(
    triggers
      .filter(isRecord)
      .filter(triggerCarriesLiveGuard)
      .map((trigger) => readString(trigger.triggerId))
      .filter((id): id is string => id !== null),
  ) : new Set<string>();

  for (const candidate of tags) {
    if (!isRecord(candidate)) {
      refuse(GTM_AUDIT_CODES.MALFORMED_EXPORT, "container holds a tag entry that is not an object");
      continue;
    }

    const label = `${readString(candidate.name) ?? "unnamed"} (#${readString(candidate.tagId) ?? "?"})`;

    if (payloadStrings(candidate, variables).truncated) {
      refuse(
        GTM_AUDIT_CODES.MALFORMED_EXPORT,
        `${label} nests parameters deeper than this audit will walk`,
      );
    }

    if (tagIsMeta(candidate, variables)) {
      refuse(
        GTM_AUDIT_CODES.META_TAG_PRESENT,
        `${label} looks like a Meta integration; Meta stays direct and must not enter GTM`,
      );
    }

    const type = readString(candidate.type) ?? "";

    // A live guard says when a tag fires, never where it delivers. For a type this audit has no
    // reviewed parser for, nothing in the export bounds the destination, so the guard cannot stand
    // in for one and the artifact is refused.
    const customHtml = type === "html" ? customHtmlOf(candidate) : null;
    const isReviewedCustomHtml = customHtml !== null && reviewedHtmlHashes.has(sha256Hex(customHtml));
    const isReviewedTemplateTag = pinnedTemplateTagTypes.has(type);

    if (!REVIEWED_TAG_TYPES.has(type) && !isReviewedCustomHtml && !isReviewedTemplateTag) {
      refuse(
        GTM_AUDIT_CODES.UNAUDITABLE_TAG_TYPE,
        `${label} has tag type "${type === "" ? "(none)" : type}", which this audit has no reviewed parser for`,
      );
    }

    if (!NON_DELIVERING_TAG_TYPES.has(type)) {
      const declaresSequencing = ["setupTag", "teardownTag"].some(
        (key) => Array.isArray(candidate[key]) && (candidate[key] as unknown[]).length > 0,
      );
      const isSequenced = sequencedTagNames.has(readString(candidate.name) ?? "\u0000");
      if (declaresSequencing || isSequenced) {
        refuse(
          GTM_AUDIT_CODES.TAG_SEQUENCING_NOT_AUDITABLE,
          `${label} takes part in tag sequencing, which can fire it without its own trigger being evaluated`,
        );
      }

      const firingTriggerIds = Array.isArray(candidate.firingTriggerId)
        ? candidate.firingTriggerId.map(readString).filter((id): id is string => id !== null)
        : [];
      // Every firing path must be guarded: one unguarded trigger is enough to fire the tag, and a
      // dangling id cannot be shown to carry a guard at all.
      const guarded =
        firingTriggerIds.length > 0
        && firingTriggerIds.every((id) => guardedTriggerIds.has(id));
      if (!guarded) {
        refuse(
          GTM_AUDIT_CODES.TAG_WITHOUT_LIVE_GUARD,
          `${label} can fire without ${TRACKING_MODE_VARIABLE} == ${LIVE_MODE}`,
        );
      }
    }

    if (isGoogleConfigurationTag(candidate) && !provesPageViewsDisabled(candidate, variables)) {
      refuse(
        GTM_AUDIT_CODES.GA4_AUTOMATIC_PAGE_VIEW,
        `${label} does not prove page views are disabled; the application owns the canonical page view`,
      );
    }

    // Which destination fields this tag type is entitled to carry. A field outside that set is a
    // vendor it was never meant to reach, so it is refused rather than checked against a union that
    // would happily accept another vendor's approved id.
    const allowedKeys = new Set<string>(
      GA4_TAG_TYPES.has(type)
        ? GA4_DESTINATION_KEYS
        : ADS_TAG_TYPES.has(type)
          ? [ADS_CONVERSION_ID_KEY, ADS_CONVERSION_LABEL_KEY]
          : isReviewedTemplateTag
            ? ["pixel_code"]
            : [],
    );
    for (const key of destinationKeysPresent(candidate)) {
      if (!allowedKeys.has(key)) {
        refuse(
          GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
          `${label} carries the destination field "${key}", which its tag type does not deliver through`,
        );
      }
    }

    const unresolved = new Set<string>();
    const readKey = (key: string) => {
      const values = destinationValues(candidate, key, variables);
      for (const reference of values.unresolved) unresolved.add(reference);
      return values.resolved;
    };

    if (GA4_TAG_TYPES.has(type)) {
      let namesGa4Destination = false;
      let namesAdsAccount = false;
      for (const key of GA4_DESTINATION_KEYS) {
        for (const id of readKey(key)) {
          if (type === "googtag" && key === "tagId" && id.startsWith(ADS_ACCOUNT_PREFIX)) {
            namesAdsAccount = true;
            if (!approvedAdsAccounts.has(stripAdsAccountPrefix(id))) {
              refuse(
                GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
                `${label} names a Google Ads account the owner has not reviewed`,
              );
            }
            continue;
          }
          namesGa4Destination = true;
          if (!approvedGa4.has(id)) {
            refuse(
              GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
              `${label} names a GA4 destination the owner has not reviewed`,
            );
          }
        }
      }

      // A configuration tag establishes the destination the events that follow are sent to, so it
      // has to say which one, in a field this audit reads. Checking only the ids it happens to find
      // would certify a tag that names its property somewhere this parser does not look — the same
      // proof a Google Ads conversion already owes about its own action.
      if (isGoogleConfigurationTag(candidate) && !namesGa4Destination && !namesAdsAccount) {
        refuse(
          GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
          `${label} configures a Google destination without naming one this audit can check`,
        );
      }
    }

    if (ADS_TAG_TYPES.has(type)) {
      // The id names the account; the label names the conversion action. Approving them separately
      // would let an approved id carry the label of a conversion nobody reviewed, so the pair is
      // what must match — and a conversion that names no label proves nothing about which action it
      // reports.
      const conversionIds = readKey(ADS_CONVERSION_ID_KEY);
      const conversionLabels = readKey(ADS_CONVERSION_LABEL_KEY);

      if (conversionIds.length === 0 || conversionLabels.length === 0) {
        refuse(
          GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
          `${label} does not name both a conversion id and a conversion label, so the conversion action it reports cannot be checked`,
        );
      }

      for (const conversionId of conversionIds) {
        for (const conversionLabel of conversionLabels) {
          if (!approvedAdsPairs.has(`${conversionId}\u0000${conversionLabel}`)) {
            refuse(
              GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
              approvedAdsIds.has(conversionId)
                ? `${label} pairs a reviewed conversion id with a conversion label the owner has not reviewed`
                : `${label} names a Google Ads conversion the owner has not reviewed`,
            );
          }
        }
      }
    }

    // A reviewed Custom HTML tag is certified by its bytes, but the ids it loads must still be ones
    // the owner approved: the pin proves the snippet is the one that was read, not that it was read
    // against this approval.
    if (isReviewedCustomHtml && customHtml !== null) {
      const loaded = tiktokLoadedIds(customHtml);
      if (loaded.length === 0) {
        refuse(
          GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
          `${label} is a reviewed snippet that loads no TikTok pixel this audit can check`,
        );
      }
      for (const id of loaded) {
        if (!approvedTiktok.has(id)) {
          refuse(
            GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
            `${label} names a TikTok destination the owner has not reviewed`,
          );
        }
      }
    }

    // A reviewed template tag must say which pixel it reports to, in the field the template reads.
    if (isReviewedTemplateTag && readKey("pixel_code").length === 0) {
      refuse(
        GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
        `${label} does not name a TikTok pixel, so the destination it reports to cannot be checked`,
      );
    }

    for (const key of TIKTOK_DESTINATION_KEYS) {
      for (const id of readKey(key)) {
        if (!approvedTiktok.has(id)) {
          refuse(
            GTM_AUDIT_CODES.UNAPPROVED_DESTINATION,
            `${label} names a TikTok destination the owner has not reviewed`,
          );
        }
      }
    }

    for (const reference of unresolved) {
      refuse(
        GTM_AUDIT_CODES.UNRESOLVED_DESTINATION_REFERENCE,
        `${label} names its destination through "${reference}", which this audit cannot resolve to a reviewed literal`,
      );
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    containerVersionId,
    containerPublicId,
  });
}
