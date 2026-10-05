import assert from "node:assert/strict";
import test from "node:test";

import { readTryOnRuntimeConfig } from "../../src/integrations/try-on/config.ts";

const VERTEX = {
  LA_TRY_ON_ENABLED: "true",
  LA_TRY_ON_PROVIDER: "vertex",
  LA_TRY_ON_GCP_PROJECT_ID: "lana-design-prod",
  LA_TRY_ON_GCP_LOCATION: "asia-southeast1",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google.json",
} as const;

test("try-on stays fail-closed when the kill switch is off", () => {
  assert.deepEqual(readTryOnRuntimeConfig({ ...VERTEX, LA_TRY_ON_ENABLED: "false" }), {
    available: false,
    reason: "DISABLED",
  });
});

test("vertex remains the backward-compatible provider when LA_TRY_ON_PROVIDER is omitted", () => {
  const { LA_TRY_ON_PROVIDER: _ignored, ...legacy } = VERTEX;
  assert.deepEqual(readTryOnRuntimeConfig(legacy), {
    available: true,
    provider: "vertex",
    projectId: "lana-design-prod",
    location: "asia-southeast1",
  });
});

test("flow requires a private worker URL and a high-entropy token", () => {
  const base = {
    LA_TRY_ON_ENABLED: "true",
    LA_TRY_ON_PROVIDER: "flow",
  };
  assert.deepEqual(readTryOnRuntimeConfig(base), {
    available: false,
    reason: "NOT_CONFIGURED",
  });
  assert.deepEqual(
    readTryOnRuntimeConfig({
      ...base,
      LA_TRY_ON_FLOW_URL: "http://flow-worker:8787",
      LA_TRY_ON_FLOW_TOKEN: "too-short",
    }),
    { available: false, reason: "NOT_CONFIGURED" },
  );
});

test("flow config is server-owned and normalized", () => {
  const token = "f".repeat(64);
  assert.deepEqual(
    readTryOnRuntimeConfig({
      LA_TRY_ON_ENABLED: "true",
      LA_TRY_ON_PROVIDER: "flow",
      LA_TRY_ON_FLOW_URL: "http://flow-worker:8787/",
      LA_TRY_ON_FLOW_TOKEN: token,
    }),
    {
      available: true,
      provider: "flow",
      workerUrl: "http://flow-worker:8787",
      workerToken: token,
    },
  );
});

test("flow config rejects URL credentials, non-http schemes and extra path/query state", () => {
  const token = "f".repeat(64);
  for (const workerUrl of [
    "ftp://flow-worker:8787",
    "http://user:password@flow-worker:8787",
    "http://flow-worker:8787/path",
    "http://flow-worker:8787/?debug=1",
    "http://flow-worker:8787/#debug",
    "https://example.com",
    "http://10.0.0.8:8787",
    "not-a-url",
  ]) {
    assert.deepEqual(
      readTryOnRuntimeConfig({
        LA_TRY_ON_ENABLED: "true",
        LA_TRY_ON_PROVIDER: "flow",
        LA_TRY_ON_FLOW_URL: workerUrl,
        LA_TRY_ON_FLOW_TOKEN: token,
      }),
      { available: false, reason: "NOT_CONFIGURED" },
      workerUrl,
    );
  }
});

test("an unknown provider fails closed instead of guessing", () => {
  assert.deepEqual(
    readTryOnRuntimeConfig({
      ...VERTEX,
      LA_TRY_ON_PROVIDER: "something-else",
    }),
    { available: false, reason: "NOT_CONFIGURED" },
  );
});
