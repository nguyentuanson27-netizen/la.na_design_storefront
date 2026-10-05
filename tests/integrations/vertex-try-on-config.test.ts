import assert from "node:assert/strict";
import test from "node:test";

import { readTryOnConfig } from "../../src/integrations/vertex-try-on/config.ts";

const ready = {
  LA_TRY_ON_ENABLED: "true",
  LA_TRY_ON_GCP_PROJECT_ID: "lana-design-prod",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google-credentials.json",
};

test("try-on is off unless the server switch is exactly 'true' (feature flag off path)", () => {
  for (const LA_TRY_ON_ENABLED of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
    assert.deepEqual(readTryOnConfig({ ...ready, LA_TRY_ON_ENABLED }), {
      available: false,
      reason: "DISABLED",
    });
  }
  assert.deepEqual(readTryOnConfig({}), { available: false, reason: "DISABLED" });
});

test("a ready environment is available with the default asia-southeast1 region", () => {
  assert.deepEqual(readTryOnConfig(ready), {
    available: true,
    projectId: "lana-design-prod",
    location: "asia-southeast1",
  });
});

test("the region can be overridden by a reviewed deployment", () => {
  const config = readTryOnConfig({ ...ready, LA_TRY_ON_GCP_LOCATION: "us-central1" });
  assert.deepEqual(config, { available: true, projectId: "lana-design-prod", location: "us-central1" });
});

test("missing provider configuration fails closed without throwing", () => {
  assert.deepEqual(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_PROJECT_ID: undefined }), {
    available: false,
    reason: "NOT_CONFIGURED",
  });
  assert.deepEqual(readTryOnConfig({ ...ready, GOOGLE_APPLICATION_CREDENTIALS: undefined }), {
    available: false,
    reason: "NOT_CONFIGURED",
  });
  assert.deepEqual(readTryOnConfig({ ...ready, GOOGLE_APPLICATION_CREDENTIALS: "  " }), {
    available: false,
    reason: "NOT_CONFIGURED",
  });
});

test("a malformed project or region is unavailable, never interpolated into a hostname", () => {
  for (const LA_TRY_ON_GCP_PROJECT_ID of ["Bad_Project", "a", "x/../y", "proj.evil.com", "-lead"]) {
    assert.equal(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_PROJECT_ID }).available, false);
  }
  for (const LA_TRY_ON_GCP_LOCATION of ["evil.com/x", "asia-southeast1.evil.com", "A B", "a@b"]) {
    assert.equal(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_LOCATION }).available, false);
  }
});

test("the configuration carries no credential material", () => {
  const config = readTryOnConfig(ready);
  assert.doesNotMatch(JSON.stringify(config), /credentials|secret|key/i);
});
