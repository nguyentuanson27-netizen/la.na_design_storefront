/**
 * CI gate for `src/tracking/reviewed-gtm-version.json`.
 *
 * The first test runs against the repository's REAL record: an all-null record is valid (closed), and
 * a filled one must be backed by the checked-in export bytes, digest, identities and a passing audit.
 * The rest prove the verifier rejects an apparently well-formed record whose evidence is wrong.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { REVIEWED_GTM_VERSION, type ReviewedGtmVersion } from "../../src/tracking/config.ts";
import { verifyReviewedGtmEvidence } from "../../src/tracking/reviewed-gtm-evidence.ts";

const ID = "GTM-FIXTURE";
const APPROVED = {
  ga4MeasurementIds: ["G-FIXTURE001"],
  googleAdsConversions: [],
  tiktokPixelIds: [],
} as const;

function exportJson({ withUnguardedTag = false }: { withUnguardedTag?: boolean } = {}) {
  const tag = (id: string, trigger: string) => ({
    tagId: id,
    name: `GA4 ${id}`,
    type: "gaawc",
    firingTriggerId: [trigger],
    parameter: [
      { type: "TEMPLATE", key: "measurementId", value: "G-FIXTURE001" },
      { type: "BOOLEAN", key: "sendPageView", value: "false" },
    ],
  });
  return {
    exportFormatVersion: 2,
    containerVersion: {
      accountId: "0",
      containerId: "0",
      containerVersionId: "7",
      container: { publicId: ID, usageContext: ["web"] },
      tag: withUnguardedTag ? [tag("1", "10"), tag("2", "11")] : [tag("1", "10")],
      trigger: [
        {
          triggerId: "10",
          name: "Tracking mode is live",
          type: "pageview",
          filter: [
            {
              type: "equals",
              parameter: [
                { type: "TEMPLATE", key: "arg0", value: "{{la_tracking_mode}}" },
                { type: "TEMPLATE", key: "arg1", value: "live" },
              ],
            },
          ],
        },
        { triggerId: "11", name: "All pages", type: "pageview" },
      ],
      variable: [
        {
          variableId: "1",
          name: "la_tracking_mode",
          type: "v",
          parameter: [
            { type: "INTEGER", key: "dataLayerVersion", value: "2" },
            { type: "TEMPLATE", key: "name", value: "la_tracking_mode" },
          ],
        },
      ],
    },
  };
}

function repositoryWith(exportBody: unknown | null, path = "docs/gtm/export.json") {
  const root = mkdtempSync(join(tmpdir(), "gtm-evidence-"));
  let sha = "0".repeat(64);
  if (exportBody !== null) {
    const bytes = JSON.stringify(exportBody);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    sha = createHash("sha256").update(bytes).digest("hex");
  }
  const record: ReviewedGtmVersion = {
    containerId: ID,
    versionId: "7",
    exportPath: path,
    exportSha256: sha,
    approvedDestinations: APPROVED,
  };
  return { root, record };
}

test("the repository's own reviewed-GTM record is either closed or fully backed by its export", () => {
  const result = verifyReviewedGtmEvidence(REVIEWED_GTM_VERSION, resolve("."));
  assert.deepEqual([...result.problems], []);
  assert.equal(result.ok, true);
});

test("an all-null record is the valid closed state", () => {
  const closed: ReviewedGtmVersion = {
    containerId: null,
    versionId: null,
    exportPath: null,
    exportSha256: null,
    approvedDestinations: null,
  };
  assert.deepEqual(verifyReviewedGtmEvidence(closed, resolve(".")), {
    active: false,
    ok: true,
    problems: [],
  });
});

test("a record backed by a matching, audited export is accepted", () => {
  const { root, record } = repositoryWith(exportJson());
  const result = verifyReviewedGtmEvidence(record, root);
  assert.deepEqual([...result.problems], []);
  assert.equal(result.ok, true);
});

test("a well-formed record pointing at a missing export is rejected", () => {
  const { root, record } = repositoryWith(null);
  const result = verifyReviewedGtmEvidence(record, root);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /not checked in/);
});

test("a wrong digest is rejected", () => {
  const { root, record } = repositoryWith(exportJson());
  const result = verifyReviewedGtmEvidence({ ...record, exportSha256: "f".repeat(64) }, root);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /SHA-256/);
});

test("a mismatched container or saved version id is rejected", () => {
  const { root, record } = repositoryWith(exportJson());
  const otherVersion = verifyReviewedGtmEvidence({ ...record, versionId: "8" }, root);
  assert.equal(otherVersion.ok, false);
  assert.match(otherVersion.problems.join("\n"), /saved version id/);
  const otherContainer = verifyReviewedGtmEvidence({ ...record, containerId: "GTM-OTHER123" }, root);
  assert.equal(otherContainer.ok, false);
});

test("an export with an unguarded production tag fails the audit even with a valid digest", () => {
  const { root, record } = repositoryWith(exportJson({ withUnguardedTag: true }));
  const result = verifyReviewedGtmEvidence(record, root);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /TAG_WITHOUT_LIVE_GUARD/);
});

test("a partially filled record and an escaping export path are rejected", () => {
  const { root, record } = repositoryWith(exportJson());
  assert.equal(verifyReviewedGtmEvidence({ ...record, approvedDestinations: null }, root).ok, false);
  const escaping = verifyReviewedGtmEvidence({ ...record, exportPath: "../outside.json" }, root);
  assert.equal(escaping.ok, false);
  assert.match(escaping.problems.join("\n"), /repository-relative/);
});
