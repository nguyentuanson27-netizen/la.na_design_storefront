import assert from "node:assert/strict";
import test from "node:test";

import { resolveGtmLoad } from "../../src/integrations/gtm/config.ts";
import {
  isReviewedGtmContainer,
  REVIEWED_GTM_VERSION,
  type ReviewedGtmVersion,
} from "../../src/tracking/config.ts";

const ID = "GTM-PRZT92JR";
const REVIEWED: ReviewedGtmVersion = {
  containerId: ID,
  versionId: "7",
  exportPath: "docs/gtm/GTM-PRZT92JR-v7.json",
  exportSha256: "b".repeat(64),
  approvedDestinations: { ga4MeasurementIds: ["G-FIXTURE001"], googleAdsConversions: [], tiktokPixelIds: [] },
};
const EMPTY: ReviewedGtmVersion = {
  containerId: null,
  versionId: null,
  exportPath: null,
  exportSha256: null,
  approvedDestinations: null,
};

test("the repository's own record reviews exactly GTM-PRZT92JR and no other container", () => {
  assert.equal(REVIEWED_GTM_VERSION.containerId, ID);
  assert.equal(isReviewedGtmContainer(ID), true);
  assert.equal(isReviewedGtmContainer("GTM-OTHER123"), false);

  const live = { LA_TRACKING_MODE: "live", LA_GTM_CONTAINER_ID: ID, NEXT_PUBLIC_GTM_CONTAINER_ID: ID };
  assert.deepEqual(resolveGtmLoad(live), { load: true, containerId: ID });
  assert.deepEqual(resolveGtmLoad({ ...live, LA_TRACKING_MODE: "preview" }), { load: true, containerId: ID });
  // Same environment, other container: not the reviewed one, so nothing loads.
  assert.deepEqual(
    resolveGtmLoad({ ...live, LA_GTM_CONTAINER_ID: "GTM-OTHER123", NEXT_PUBLIC_GTM_CONTAINER_ID: "GTM-OTHER123" }),
    { load: false },
  );
  // The reviewed container with the mode disabled or absent never loads.
  assert.deepEqual(resolveGtmLoad({ ...live, LA_TRACKING_MODE: "disabled", LA_GTM_CONTAINER_ID: "" }), { load: false });
  assert.deepEqual(resolveGtmLoad({ NEXT_PUBLIC_GTM_CONTAINER_ID: ID }), { load: false });
});

test("disabled never loads, even for a reviewed container with the public id set", () => {
  assert.deepEqual(resolveGtmLoad({ NEXT_PUBLIC_GTM_CONTAINER_ID: ID }, REVIEWED), { load: false });
  assert.deepEqual(
    resolveGtmLoad({ LA_TRACKING_MODE: "disabled", NEXT_PUBLIC_GTM_CONTAINER_ID: ID }, REVIEWED),
    { load: false },
  );
});

test("preview and live load only the reviewed container", () => {
  for (const mode of ["preview", "live"]) {
    const env = { LA_TRACKING_MODE: mode, LA_GTM_CONTAINER_ID: ID, NEXT_PUBLIC_GTM_CONTAINER_ID: ID };
    assert.deepEqual(resolveGtmLoad(env, REVIEWED), { load: true, containerId: ID }, mode);
    assert.deepEqual(resolveGtmLoad(env, EMPTY), { load: false }, `${mode} unreviewed`);
    assert.deepEqual(
      resolveGtmLoad(env, { ...REVIEWED, containerId: "GTM-OTHER123" }),
      { load: false },
      `${mode} different reviewed container`,
    );
  }
});

test("a server-id-only deployment resolves the same container for loader and tracking config", () => {
  assert.deepEqual(
    resolveGtmLoad({ LA_TRACKING_MODE: "live", LA_GTM_CONTAINER_ID: ID }, REVIEWED),
    { load: true, containerId: ID },
  );
});

test("conflicting ids and an incomplete record fail closed", () => {
  assert.deepEqual(
    resolveGtmLoad(
      { LA_TRACKING_MODE: "live", LA_GTM_CONTAINER_ID: ID, NEXT_PUBLIC_GTM_CONTAINER_ID: "GTM-OTHER123" },
      REVIEWED,
    ),
    { load: false },
  );
  for (const broken of [
    { ...REVIEWED, versionId: null },
    { ...REVIEWED, exportPath: "" },
    { ...REVIEWED, exportSha256: "not-a-checksum" },
    { ...REVIEWED, approvedDestinations: null },
  ]) {
    assert.equal(isReviewedGtmContainer(ID, broken), false);
  }
});
