import assert from "node:assert/strict";
import test from "node:test";

import { TRY_ON_LOCATION, readTryOnConfig } from "../../src/integrations/vertex-try-on/config.ts";

const ready = {
  LA_TRY_ON_ENABLED: "true",
  LA_TRY_ON_GCP_PROJECT_ID: "lana-design-prod",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google-credentials.json",
};

test("try-on is off unless the server switch is exactly 'true'", () => {
  for (const LA_TRY_ON_ENABLED of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
    assert.deepEqual(readTryOnConfig({ ...ready, LA_TRY_ON_ENABLED }), {
      available: false,
      reason: "DISABLED",
    });
  }
  assert.deepEqual(readTryOnConfig({}), { available: false, reason: "DISABLED" });
});

test("Nano Banana Pro is pinned to the Vertex global location", () => {
  assert.equal(TRY_ON_LOCATION, "global");
  assert.deepEqual(readTryOnConfig(ready), {
    available: true,
    projectId: "lana-design-prod",
    location: "global",
  });
  assert.deepEqual(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_LOCATION: "global" }), {
    available: true,
    projectId: "lana-design-prod",
    location: "global",
  });
});

test("a stale regional location fails closed instead of calling an unsupported endpoint", () => {
  for (const LA_TRY_ON_GCP_LOCATION of ["asia-southeast1", "us-central1", "evil.com/x", " global "]) {
    assert.deepEqual(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_LOCATION }), {
      available: false,
      reason: "NOT_CONFIGURED",
    });
  }
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

test("a malformed project id is unavailable, never interpolated into the endpoint", () => {
  for (const LA_TRY_ON_GCP_PROJECT_ID of ["Bad_Project", "a", "x/../y", "proj.evil.com", "-lead"]) {
    assert.equal(readTryOnConfig({ ...ready, LA_TRY_ON_GCP_PROJECT_ID }).available, false);
  }
});

test("the configuration carries no credential material", () => {
  const config = readTryOnConfig(ready);
  assert.doesNotMatch(JSON.stringify(config), /credentials|secret|key/i);
});
