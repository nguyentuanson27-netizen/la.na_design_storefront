/**
 * The CI-enforced binding between `reviewed-gtm-version.json` and the evidence it claims.
 *
 * `isReviewedGtmContainer()` can only check the SHAPE of the record at runtime. This module is the
 * part that makes the record mean something: the referenced export must be a checked-in file inside
 * the repository, its SHA-256 must equal the recorded digest, its container and saved-version
 * identities must equal the record, and `auditGtmContainerExport()` must pass against the
 * owner-approved destinations written in the record.
 *
 * It reads the filesystem, so it is a build/CI tool and is never imported by application code.
 * An all-null record is the closed state and is valid: nothing is reviewed, nothing may load.
 *
 * What this cannot prove: that the container GTM serves right now is the reviewed version. The
 * loader requests the container by its public id, which delivers whatever is PUBLISHED. Release must compare
 * the published version with `versionId` (docs/specs/marketing-analytics-shopping.md §5.2).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ReviewedGtmVersion } from "./config.ts";
import { auditGtmContainerExport } from "./gtm-container-audit.ts";

export type ReviewedGtmEvidenceResult = Readonly<{
  /** Whether the record claims a reviewed container at all (false for the closed, all-null state). */
  active: boolean;
  ok: boolean;
  problems: readonly string[];
}>;

const FIELDS = ["containerId", "versionId", "exportPath", "exportSha256", "approvedDestinations"] as const;

export function verifyReviewedGtmEvidence(
  record: ReviewedGtmVersion,
  repositoryRoot: string,
): ReviewedGtmEvidenceResult {
  const present = FIELDS.filter((field) => record[field] !== null);
  if (present.length === 0) return Object.freeze({ active: false, ok: true, problems: [] });

  const problems: string[] = [];
  const missing = FIELDS.filter((field) => record[field] === null);
  if (missing.length > 0) {
    problems.push(`record is partially filled; missing: ${missing.join(", ")}`);
    return Object.freeze({ active: true, ok: false, problems });
  }

  const exportPath = record.exportPath as string;
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, exportPath);
  const relativePath = relative(root, absolute);
  if (
    isAbsolute(exportPath) ||
    relativePath.startsWith("..") ||
    relativePath.split(sep).includes("..") ||
    relativePath.length === 0
  ) {
    problems.push("exportPath must be a repository-relative file path");
    return Object.freeze({ active: true, ok: false, problems });
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    problems.push(`export file is not checked in at ${exportPath}`);
    return Object.freeze({ active: true, ok: false, problems });
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.exportSha256) {
    problems.push("export file SHA-256 does not equal the recorded exportSha256");
  }

  let source: unknown;
  try {
    source = JSON.parse(bytes.toString("utf8"));
  } catch {
    problems.push("export file is not valid JSON");
    return Object.freeze({ active: true, ok: false, problems });
  }

  const approved = record.approvedDestinations!;
  const audit = auditGtmContainerExport({
    source,
    approved: {
      gtmContainerId: record.containerId as string,
      ga4MeasurementIds: approved.ga4MeasurementIds,
      googleAdsConversions: approved.googleAdsConversions,
      tiktokPixelIds: approved.tiktokPixelIds,
    },
  });
  if (!audit.ok) {
    problems.push(
      `static GTM audit failed: ${[...new Set(audit.findings.map((finding) => finding.code))].join(", ")}`,
    );
  }
  if (audit.containerPublicId !== record.containerId) {
    problems.push("export container id does not equal the recorded containerId");
  }
  if (audit.containerVersionId !== record.versionId) {
    problems.push("export saved version id does not equal the recorded versionId");
  }

  return Object.freeze({ active: true, ok: problems.length === 0, problems });
}
