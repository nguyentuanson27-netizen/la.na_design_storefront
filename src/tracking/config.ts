/**
 * Desired tracking configuration and the fail-closed GTM interlock.
 *
 * The application owns which measurement mode a deployment *wants*. Whether Google Tag Manager is
 * actually loaded is a separate, stricter question: no GTM container may be loaded until an exact
 * saved container version has been exported and reviewed (marketing spec §5.1). Until that unit
 * lands, `disabled`, `preview` and `live` all resolve to the same operational outcome — no GTM
 * script, no vendor network delivery — while still letting a deployment express and test its
 * intended mode.
 *
 * The mode is deliberately a server-only variable. A `NEXT_PUBLIC_` value, the `Host` header or any
 * other request-controlled input must never be able to promote a deployment to `live`.
 */

import reviewedGtmVersion from "./reviewed-gtm-version.json" with { type: "json" };

type TrackingEnvironment = Readonly<Record<string, string | undefined>>;

export const TRACKING_MODES = ["disabled", "preview", "live"] as const;

export type TrackingMode = (typeof TRACKING_MODES)[number];

export type TrackingConfig = Readonly<{
  desiredMode: TrackingMode;
  containerId: string | null;
}>;

export type TrackingRuntime = Readonly<{
  mode: TrackingMode;
  containerId: string | null;
  /** Whether the browser bootstrap (dataLayer, mode, consent defaults, page views) is rendered. */
  publishesDataLayer: boolean;
  /**
   * Whether the loader may render. False unless the container is the reviewed one recorded in
   * `reviewed-gtm-version.json` AND the mode is not `disabled`.
   */
  loadsGoogleTagManager: boolean;
}>;

const GTM_CONTAINER_ID = /^GTM-[A-Z0-9]{4,10}$/;

/**
 * The evidence that an exact saved GTM container version was exported, audited and reviewed
 * (marketing spec §5.1–5.2). The gate is DATA, not a boolean someone can flip: it is open only for
 * the container this record names, and only when every field of the record is present. Filling the
 * record belongs to the unit that exports, checksums and reviews that version; `next.config.mjs`
 * reads the same file to decide whether the CSP opens, so the loader and the CSP cannot disagree.
 */
export type ReviewedGtmVersion = Readonly<{
  containerId: string | null;
  versionId: string | null;
  exportPath: string | null;
  exportSha256: string | null;
}>;

export const REVIEWED_GTM_VERSION: ReviewedGtmVersion = Object.freeze({
  ...(reviewedGtmVersion as ReviewedGtmVersion),
});

export function isReviewedGtmContainer(
  containerId: string | null,
  record: ReviewedGtmVersion = REVIEWED_GTM_VERSION,
): boolean {
  return (
    containerId !== null &&
    GTM_CONTAINER_ID.test(containerId) &&
    record.containerId === containerId &&
    record.versionId !== null &&
    record.versionId.length > 0 &&
    record.exportPath !== null &&
    record.exportPath.length > 0 &&
    record.exportSha256 !== null &&
    /^[0-9a-f]{64}$/.test(record.exportSha256)
  );
}

function isTrackingMode(value: string): value is TrackingMode {
  return (TRACKING_MODES as readonly string[]).includes(value);
}

export function readTrackingConfig(env: TrackingEnvironment = process.env): TrackingConfig {
  const rawMode = env.LA_TRACKING_MODE;
  // Absent is the fail-closed default; a present-but-unrecognised value is a deployment mistake and
  // must not silently degrade to "disabled" in a deployment that believes it is measuring.
  const desiredMode = rawMode === undefined ? "disabled" : rawMode;
  if (!isTrackingMode(desiredMode)) {
    throw new RangeError(`LA_TRACKING_MODE must be one of ${TRACKING_MODES.join(", ")}`);
  }

  const rawContainerId = env.LA_GTM_CONTAINER_ID;
  if (desiredMode === "disabled") {
    if (rawContainerId !== undefined && rawContainerId.length > 0) {
      throw new RangeError(
        "LA_GTM_CONTAINER_ID must not be configured while LA_TRACKING_MODE is disabled",
      );
    }
    return Object.freeze({ desiredMode, containerId: null });
  }

  if (rawContainerId === undefined || !GTM_CONTAINER_ID.test(rawContainerId)) {
    throw new RangeError(
      "LA_GTM_CONTAINER_ID must be the GTM-XXXXXXX container id from Tag Manager",
    );
  }

  return Object.freeze({ desiredMode, containerId: rawContainerId });
}

export function resolveTrackingRuntime(
  config: TrackingConfig,
  record: ReviewedGtmVersion = REVIEWED_GTM_VERSION,
): TrackingRuntime {
  return Object.freeze({
    mode: config.desiredMode,
    containerId: config.containerId,
    publishesDataLayer: config.desiredMode !== "disabled",
    loadsGoogleTagManager:
      config.desiredMode !== "disabled" && isReviewedGtmContainer(config.containerId, record),
  });
}

/**
 * The single place the loader asks before rendering a GTM script. False for every mode until a
 * reviewed container version is recorded, and always false for `disabled`.
 */
export function shouldLoadGoogleTagManager(runtime: TrackingRuntime): boolean {
  return runtime.loadsGoogleTagManager;
}
