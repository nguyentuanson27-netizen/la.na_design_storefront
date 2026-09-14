/**
 * Tooling for the M1 identifier-durability experiment.
 *
 * What this measures, and the limit that matters: the comparison runs on snapshots read back from
 * the catalog mirror, and the mirror reconciles products by `pancakeProductId` and variations by
 * `pancakeVariationId` — the very keys whose durability is in question. So a stable identifier set
 * across runs, and a preserved internal row id for a given external id, follow from the upsert
 * itself. They confirm the repository reconciles by external id, which repository tests already
 * establish; they cannot establish that the upstream object behind an identifier is still the same
 * object.
 *
 * The case this is blind to is concrete: if a provider recycles or remaps an identifier onto a
 * different object, the identifier set is unchanged, the mirror writes the new data into the same
 * row, and every number here still reads as perfect stability.
 *
 * Nothing in this module may therefore report upstream lifetime durability as proven. Establishing
 * that needs a correlate captured at the live provider boundary, independent of the identifier being
 * tested — or a provider contract, or approved historical evidence.
 */

import { createHash } from "node:crypto";

import { readProjectConfig } from "../config/project-config.ts";

/**
 * The audit database is derived from the committed project identity rather than written out, so a
 * fork protects its own database instead of inheriting this one's name. The guard itself is
 * unchanged: write-capable evidence still refuses to run anywhere but the audit database.
 */
export const ALLOWED_AUDIT_DATABASE_NAME = `${readProjectConfig().databaseName}_durability_audit`;
export const CI_REFUSAL_MESSAGE = "Trusted Pancake durability evidence script refuses CI execution";

function isEnvironmentFlagEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return true;
}

export function extractDatabaseNameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const dbName = parsed.pathname.replace(/^\/+/, "").split("/")[0]?.split("?")[0] ?? "";
    return decodeURIComponent(dbName);
  } catch {
    throw new Error("Invalid DATABASE_URL format");
  }
}

export function assertAuditDatabaseUrl(databaseUrl: string | undefined): { databaseName: string } {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required to run durability evidence");
  }

  let dbName: string;
  try {
    dbName = extractDatabaseNameFromUrl(databaseUrl);
  } catch {
    throw new Error("Refusing to run durability evidence: DATABASE_URL is malformed");
  }

  if (dbName !== ALLOWED_AUDIT_DATABASE_NAME) {
    throw new Error(
      `Refusing to run write-capable durability evidence on non-audit database: expected database '${ALLOWED_AUDIT_DATABASE_NAME}', got '${dbName}'`,
    );
  }

  return { databaseName: dbName };
}

export function assertDurabilityEvidenceEnvironment(
  env: Record<string, string | undefined> = process.env,
): { databaseName: string } {
  if (isEnvironmentFlagEnabled(env.CI) || isEnvironmentFlagEnabled(env.GITHUB_ACTIONS)) {
    throw new Error(CI_REFUSAL_MESSAGE);
  }

  return assertAuditDatabaseUrl(env.DATABASE_URL);
}

export type CatalogIdSnapshot = Readonly<{
  runIndex: number;
  timestamp: string;
  shopId: number;
  productExternalIds: readonly string[];
  variationExternalIds: readonly string[];
  productExternalIdsHash: string;
  variationExternalIdsHash: string;
  internalVariantIdMap?: Readonly<Record<string, string>>;
}>;

export type DurabilityComparisonResult = Readonly<{
  runsAudited: number;
  totalProductsPerRun: readonly number[];
  totalVariationsPerRun: readonly number[];
  disappearedProductIds: readonly string[];
  appearedProductIds: readonly string[];
  disappearedVariationIds: readonly string[];
  appearedVariationIds: readonly string[];
  stableProductIds: number;
  stableVariationIds: number;
  productStabilityPercent: number;
  variationStabilityPercent: number;
  duplicateProductIds: readonly string[];
  duplicateVariationIds: readonly string[];
  internalRowIdPreservedCount: number;
  internalRowIdReplacedCount: number;
  /**
   * The identifier set and the mirror's internal row ids held across the compared runs.
   *
   * Deliberately not called durable: this is set stability measured downstream of a mirror keyed by
   * the same identifiers, not evidence about upstream object lifetime.
   */
  identifierSetStableAcrossRuns: boolean;
  /**
   * Always false, and constant for the same reason the M1 audit's own durability verdict is: no
   * arrangement of the inputs this comparison receives can establish upstream lifetime.
   */
  provesUpstreamLifetimeDurability: false;
}>;

function hashIdList(ids: readonly string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function createCatalogIdSnapshot({
  runIndex,
  timestamp,
  shopId,
  productExternalIds,
  variationExternalIds,
  internalVariantIdMap,
}: {
  runIndex: number;
  timestamp: string;
  shopId: number;
  productExternalIds: readonly string[];
  variationExternalIds: readonly string[];
  internalVariantIdMap?: Readonly<Record<string, string>>;
}): CatalogIdSnapshot {
  if (!Number.isSafeInteger(runIndex) || runIndex < 0) {
    throw new TypeError("Catalog snapshot runIndex must be a non-negative integer");
  }
  if (!Number.isSafeInteger(shopId) || shopId <= 0) {
    throw new TypeError("Catalog snapshot shopId must be a positive safe integer");
  }
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    throw new TypeError("Catalog snapshot timestamp must be a non-empty string");
  }

  const sortedProductIds = [...productExternalIds].sort();
  const sortedVariationIds = [...variationExternalIds].sort();

  return Object.freeze({
    runIndex,
    timestamp,
    shopId,
    productExternalIds: Object.freeze(sortedProductIds),
    variationExternalIds: Object.freeze(sortedVariationIds),
    productExternalIdsHash: hashIdList(sortedProductIds),
    variationExternalIdsHash: hashIdList(sortedVariationIds),
    internalVariantIdMap: internalVariantIdMap ? Object.freeze({ ...internalVariantIdMap }) : undefined,
  });
}

export function compareCatalogSnapshots(
  snapshots: readonly CatalogIdSnapshot[],
): DurabilityComparisonResult {
  if (snapshots.length < 2) {
    throw new Error("Durability comparison requires at least two independent snapshots");
  }

  const baseSnapshot = snapshots[0]!;
  const shopId = baseSnapshot.shopId;

  for (let i = 1; i < snapshots.length; i += 1) {
    if (snapshots[i]!.shopId !== shopId) {
      throw new Error("Durability comparison snapshots must share the same shop scope");
    }
  }

  const baseProductSet = new Set(baseSnapshot.productExternalIds);
  const baseVariationSet = new Set(baseSnapshot.variationExternalIds);

  const disappearedProductIds = new Set<string>();
  const appearedProductIds = new Set<string>();
  const disappearedVariationIds = new Set<string>();
  const appearedVariationIds = new Set<string>();

  const allDuplicateProductIds = new Set<string>();
  const allDuplicateVariationIds = new Set<string>();

  let internalRowIdPreserved = 0;
  let internalRowIdReplaced = 0;

  for (const snapshot of snapshots) {
    for (const dup of findDuplicates(snapshot.productExternalIds)) {
      allDuplicateProductIds.add(dup);
    }
    for (const dup of findDuplicates(snapshot.variationExternalIds)) {
      allDuplicateVariationIds.add(dup);
    }
  }

  for (let i = 1; i < snapshots.length; i += 1) {
    const current = snapshots[i]!;
    const currentProductSet = new Set(current.productExternalIds);
    const currentVariationSet = new Set(current.variationExternalIds);

    for (const id of baseProductSet) {
      if (!currentProductSet.has(id)) disappearedProductIds.add(id);
    }
    for (const id of currentProductSet) {
      if (!baseProductSet.has(id)) appearedProductIds.add(id);
    }

    for (const id of baseVariationSet) {
      if (!currentVariationSet.has(id)) disappearedVariationIds.add(id);
    }
    for (const id of currentVariationSet) {
      if (!baseVariationSet.has(id)) appearedVariationIds.add(id);
    }

    if (baseSnapshot.internalVariantIdMap && current.internalVariantIdMap) {
      for (const [varId, internalId] of Object.entries(baseSnapshot.internalVariantIdMap)) {
        const currentInternalId = current.internalVariantIdMap[varId];
        if (currentInternalId !== undefined) {
          if (currentInternalId === internalId) {
            internalRowIdPreserved += 1;
          } else {
            internalRowIdReplaced += 1;
          }
        }
      }
    }
  }

  const stableProducts = baseProductSet.size - disappearedProductIds.size;
  const stableVariations = baseVariationSet.size - disappearedVariationIds.size;

  const productStabilityPercent = baseProductSet.size === 0
    ? 0
    : Math.round((stableProducts / baseProductSet.size) * 10_000) / 100;
  const variationStabilityPercent = baseVariationSet.size === 0
    ? 0
    : Math.round((stableVariations / baseVariationSet.size) * 10_000) / 100;

  const identifierSetStableAcrossRuns =
    disappearedProductIds.size === 0 &&
    appearedProductIds.size === 0 &&
    disappearedVariationIds.size === 0 &&
    appearedVariationIds.size === 0 &&
    allDuplicateProductIds.size === 0 &&
    allDuplicateVariationIds.size === 0 &&
    internalRowIdReplaced === 0 &&
    baseSnapshot.variationExternalIds.length > 0;

  return Object.freeze({
    runsAudited: snapshots.length,
    totalProductsPerRun: Object.freeze(snapshots.map((s) => s.productExternalIds.length)),
    totalVariationsPerRun: Object.freeze(snapshots.map((s) => s.variationExternalIds.length)),
    disappearedProductIds: Object.freeze([...disappearedProductIds].sort()),
    appearedProductIds: Object.freeze([...appearedProductIds].sort()),
    disappearedVariationIds: Object.freeze([...disappearedVariationIds].sort()),
    appearedVariationIds: Object.freeze([...appearedVariationIds].sort()),
    stableProductIds: stableProducts,
    stableVariationIds: stableVariations,
    productStabilityPercent,
    variationStabilityPercent,
    duplicateProductIds: Object.freeze([...allDuplicateProductIds].sort()),
    duplicateVariationIds: Object.freeze([...allDuplicateVariationIds].sort()),
    internalRowIdPreservedCount: internalRowIdPreserved,
    internalRowIdReplacedCount: internalRowIdReplaced,
    identifierSetStableAcrossRuns,
    // Constant. A comparison of identifier sets read back through a mirror keyed by those same
    // identifiers cannot prove upstream lifetime, however stable the sets look.
    provesUpstreamLifetimeDurability: false as const,
  });
}

export type CorrelatedVariationObservation = Readonly<{
  variationMarker: string;
  pancakeVariationId: string;
  displayId?: string;
  size?: string;
  barcode?: string | null;
}>;

export type CorrelatedProductObservation = Readonly<{
  productMarker: string;
  pancakeProductId: string;
  productName: string;
  variations: readonly CorrelatedVariationObservation[];
}>;

export type RawCorrelatedRunObservation = Readonly<{
  runIndex: number;
  phase: string;
  timestamp: string;
  totalCatalogEntries: number;
  totalCatalogPages: number;
  auditProduct: CorrelatedProductObservation;
}>;

export type CorrelatedDurabilityComparisonInput = Readonly<{
  expectedProductMarker?: string;
  expectedVariationMarkers?: readonly string[];
  runs: readonly RawCorrelatedRunObservation[];
}>;

export type CorrelatedDurabilityComparisonResult = Readonly<{
  runsObserved: number;
  productMarker: string;
  productMarkerStable: boolean;
  observedProductIds: readonly string[];
  stableProductId: string | null;
  variationMarkersStable: boolean;
  variationResults: readonly Readonly<{
    variationMarker: string;
    observedVariationIds: readonly string[];
    stableVariationId: string | null;
    isStable: boolean;
  }>[];
  allMarkersRetainedSameIds: boolean;
  remapDetected: boolean;
  duplicateMarkersDetected: boolean;
  missingMarkersDetected: boolean;
  unexpectedMarkersDetected: boolean;
  verdict:
    | "STABLE"
    | "REMAP_DETECTED"
    | "DUPLICATE_MARKERS"
    | "MISSING_MARKERS"
    | "UNEXPECTED_MARKERS"
    | "UNSTABLE";
}>;

export function compareCorrelatedObservations(
  inputOrRuns: readonly RawCorrelatedRunObservation[] | CorrelatedDurabilityComparisonInput,
): CorrelatedDurabilityComparisonResult {
  let runs: readonly RawCorrelatedRunObservation[];
  let expectedProductMarker: string;
  let expectedVariationMarkers: readonly string[];

  if ("runs" in inputOrRuns) {
    runs = inputOrRuns.runs;
    if (runs.length < 2) {
      throw new Error("Correlated durability comparison requires at least two independent run observations");
    }
    const baseRun = runs[0]!;
    expectedProductMarker =
      inputOrRuns.expectedProductMarker !== undefined
        ? inputOrRuns.expectedProductMarker
        : baseRun.auditProduct.productMarker;
    expectedVariationMarkers =
      inputOrRuns.expectedVariationMarkers !== undefined
        ? inputOrRuns.expectedVariationMarkers
        : baseRun.auditProduct.variations.map(
            (v: CorrelatedVariationObservation) => v.variationMarker,
          );
  } else {
    runs = inputOrRuns;
    if (runs.length < 2) {
      throw new Error("Correlated durability comparison requires at least two independent run observations");
    }
    const baseRun = runs[0]!;
    expectedProductMarker = baseRun.auditProduct.productMarker;
    expectedVariationMarkers = baseRun.auditProduct.variations.map(
      (v: CorrelatedVariationObservation) => v.variationMarker,
    );
  }

  let duplicateMarkersDetected = false;
  let missingMarkersDetected = false;
  let unexpectedMarkersDetected = false;
  let remapDetected = false;

  // 1. Check markers inside EVERY run (including T0!) against expected
  for (const run of runs) {
    const observedMarkers = run.auditProduct.variations.map(
      (v: CorrelatedVariationObservation) => v.variationMarker,
    );
    const varMarkersSet = new Set<string>();

    for (const marker of observedMarkers) {
      if (varMarkersSet.has(marker)) {
        duplicateMarkersDetected = true;
      }
      varMarkersSet.add(marker);

      if (!expectedVariationMarkers.includes(marker)) {
        unexpectedMarkersDetected = true;
      }
    }

    for (const expected of expectedVariationMarkers) {
      if (!varMarkersSet.has(expected)) {
        missingMarkersDetected = true;
      }
    }

    if (observedMarkers.length < expectedVariationMarkers.length) {
      missingMarkersDetected = true;
    }
    if (observedMarkers.length > expectedVariationMarkers.length) {
      unexpectedMarkersDetected = true;
    }
  }

  // 2. Track product marker stability across runs
  const observedProductIds: string[] = [];
  for (const run of runs) {
    const runMarker = run.auditProduct.productMarker;
    const matchesExpected =
      runMarker === expectedProductMarker || runMarker.startsWith(`${expectedProductMarker}|`);
    if (!matchesExpected) {
      missingMarkersDetected = true;
    }
    observedProductIds.push(run.auditProduct.pancakeProductId);
  }

  const distinctProductIds = [...new Set(observedProductIds)];
  const productMarkerStable = distinctProductIds.length === 1 && !missingMarkersDetected;
  if (distinctProductIds.length > 1) {
    remapDetected = true;
  }

  // 3. Track each variation marker across all runs using EXPECTED markers
  const variationResults: {
    variationMarker: string;
    observedVariationIds: readonly string[];
    stableVariationId: string | null;
    isStable: boolean;
  }[] = [];

  for (const marker of expectedVariationMarkers) {
    const observedVarIds: string[] = [];
    for (const run of runs) {
      const match = run.auditProduct.variations.find(
        (v: CorrelatedVariationObservation) => v.variationMarker === marker,
      );
      if (!match) {
        missingMarkersDetected = true;
      } else {
        observedVarIds.push(match.pancakeVariationId);
      }
    }

    const distinctVarIds = [...new Set(observedVarIds)];
    const isStable = observedVarIds.length === runs.length && distinctVarIds.length === 1;
    if (distinctVarIds.length > 1) {
      remapDetected = true;
    }

    variationResults.push({
      variationMarker: marker,
      observedVariationIds: Object.freeze(observedVarIds),
      stableVariationId: isStable ? distinctVarIds[0]! : null,
      isStable,
    });
  }

  const variationMarkersStable = variationResults.length > 0 && variationResults.every((r) => r.isStable);

  // 4. Verify that no two different markers ever share the same variation ID in any run
  for (const run of runs) {
    const idSet = new Set<string>();
    for (const v of run.auditProduct.variations) {
      if (idSet.has(v.pancakeVariationId)) {
        remapDetected = true;
      }
      idSet.add(v.pancakeVariationId);
    }
  }

  const allMarkersRetainedSameIds =
    productMarkerStable &&
    variationMarkersStable &&
    !remapDetected &&
    !duplicateMarkersDetected &&
    !missingMarkersDetected &&
    !unexpectedMarkersDetected;

  let verdict: CorrelatedDurabilityComparisonResult["verdict"] = "STABLE";
  if (duplicateMarkersDetected) {
    verdict = "DUPLICATE_MARKERS";
  } else if (unexpectedMarkersDetected) {
    verdict = "UNEXPECTED_MARKERS";
  } else if (missingMarkersDetected) {
    verdict = "MISSING_MARKERS";
  } else if (remapDetected) {
    verdict = "REMAP_DETECTED";
  } else if (!allMarkersRetainedSameIds) {
    verdict = "UNSTABLE";
  }

  return Object.freeze({
    runsObserved: runs.length,
    productMarker: expectedProductMarker,
    productMarkerStable,
    observedProductIds: Object.freeze(observedProductIds),
    stableProductId: productMarkerStable ? distinctProductIds[0]! : null,
    variationMarkersStable,
    variationResults: Object.freeze(variationResults.map((r) => Object.freeze(r))),
    allMarkersRetainedSameIds,
    remapDetected,
    duplicateMarkersDetected,
    missingMarkersDetected,
    unexpectedMarkersDetected,
    verdict,
  });
}

