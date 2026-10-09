import {
  readTrackingConfig,
  resolveTrackingRuntime,
  shouldLoadGoogleTagManager,
  REVIEWED_GTM_VERSION,
  type ReviewedGtmVersion,
} from "../../tracking/config.ts";

export type GtmConfig = Readonly<{
  containerId: string;
}>;

const GTM_CONTAINER_ID_REGEX = /^GTM-[A-Z0-9]{4,10}$/;

/**
 * Mirrors the id resolution in `next.config.mjs`, which derives the CSP: an empty value is unset, and
 * two different ids resolve to nothing (fail closed) so the loader never disagrees with the policy.
 */
export function readGtmConfig(
  env: Record<string, string | undefined> = process.env,
): GtmConfig | null {
  const publicId = (env.NEXT_PUBLIC_GTM_CONTAINER_ID ?? "").trim();
  const serverId = (env.LA_GTM_CONTAINER_ID ?? "").trim();
  if (publicId.length > 0 && serverId.length > 0 && publicId !== serverId) return null;
  const raw = publicId || serverId;
  if (!GTM_CONTAINER_ID_REGEX.test(raw)) return null;
  return Object.freeze({ containerId: raw });
}

export type GtmLoadDecision =
  | Readonly<{ load: true; containerId: string }>
  | Readonly<{ load: false }>;

/**
 * The one decision the loader obeys. It loads only when the id resolves, the tracking mode is not
 * `disabled`, and that exact container is the reviewed one recorded in `reviewed-gtm-version.json`.
 * The CSP is baked from the same record at build time (mode is runtime-only, so the CSP can only be
 * the broader of the two, never open where this decision is closed on the record).
 */
export function resolveGtmLoad(
  env: Record<string, string | undefined> = process.env,
  record: ReviewedGtmVersion = REVIEWED_GTM_VERSION,
): GtmLoadDecision {
  const config = readGtmConfig(env);
  if (config === null) return Object.freeze({ load: false as const });
  const runtime = resolveTrackingRuntime(readTrackingConfig(env), record);
  if (!shouldLoadGoogleTagManager(runtime) || runtime.containerId !== config.containerId) {
    return Object.freeze({ load: false as const });
  }
  return Object.freeze({ load: true as const, containerId: config.containerId });
}
