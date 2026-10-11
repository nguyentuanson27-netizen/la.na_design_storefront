import assert from "node:assert/strict";
import test from "node:test";

import { readTryOnRuntimeConfig } from "../../src/integrations/try-on/config.ts";

const VERTEX = {
  LA_TRY_ON_ENABLED: "true",
  LA_TRY_ON_PROVIDER: "vertex",
  LA_TRY_ON_GCP_PROJECT_ID: "lana-design-prod",
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
    location: "global",
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

const FLOW_WITH_OVERFLOW = {
  LA_TRY_ON_ENABLED: "true",
  LA_TRY_ON_PROVIDER: "flow",
  LA_TRY_ON_FLOW_URL: "http://flow-worker:8787",
  LA_TRY_ON_FLOW_TOKEN: "f".repeat(64),
  LA_TRY_ON_OVERFLOW_PROVIDER: "vertex",
  LA_TRY_ON_VERTEX_DAILY_CAP: "40",
  LA_TRY_ON_GCP_PROJECT_ID: "lana-design-prod",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/try-on-gcp/google.json",
} as const;

test("flow with a complete Vertex overflow carries the Vertex config and the daily cap", () => {
  assert.deepEqual(readTryOnRuntimeConfig(FLOW_WITH_OVERFLOW), {
    available: true,
    provider: "flow",
    workerUrl: "http://flow-worker:8787",
    workerToken: "f".repeat(64),
    overflow: {
      vertex: { available: true, provider: "vertex", projectId: "lana-design-prod", location: "global" },
      dailyCap: 40,
    },
  });
});

test("an incomplete or invalid overflow leaves Flow alone instead of disabling try-on", () => {
  const flowAlone = {
    available: true,
    provider: "flow",
    workerUrl: "http://flow-worker:8787",
    workerToken: "f".repeat(64),
  };
  const broken: Array<Record<string, string | undefined>> = [
    { LA_TRY_ON_OVERFLOW_PROVIDER: undefined },
    { LA_TRY_ON_OVERFLOW_PROVIDER: "flow" },
    { LA_TRY_ON_OVERFLOW_PROVIDER: "Vertex" },
    { LA_TRY_ON_VERTEX_DAILY_CAP: undefined },
    { LA_TRY_ON_VERTEX_DAILY_CAP: "0" },
    { LA_TRY_ON_VERTEX_DAILY_CAP: "-5" },
    { LA_TRY_ON_VERTEX_DAILY_CAP: "1.5" },
    { LA_TRY_ON_VERTEX_DAILY_CAP: "10001" },
    { LA_TRY_ON_VERTEX_DAILY_CAP: " 40" },
    { LA_TRY_ON_GCP_PROJECT_ID: undefined },
    { GOOGLE_APPLICATION_CREDENTIALS: "" },
    { LA_TRY_ON_GCP_LOCATION: "us-central1" },
  ];
  for (const change of broken) {
    const env: Record<string, string | undefined> = { ...FLOW_WITH_OVERFLOW, ...change };
    assert.deepEqual(readTryOnRuntimeConfig(env), flowAlone, JSON.stringify(change));
  }
});

test("Vertex as the primary provider never gains an overflow", () => {
  assert.deepEqual(readTryOnRuntimeConfig({ ...VERTEX, LA_TRY_ON_OVERFLOW_PROVIDER: "vertex", LA_TRY_ON_VERTEX_DAILY_CAP: "40" }), {
    available: true,
    provider: "vertex",
    projectId: "lana-design-prod",
    location: "global",
  });
});
