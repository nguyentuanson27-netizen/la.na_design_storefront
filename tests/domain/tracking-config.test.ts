import assert from "node:assert/strict";
import test from "node:test";

import {
  readTrackingConfig,
  resolveTrackingRuntime,
  shouldLoadGoogleTagManager,
  TRACKING_MODES,
} from "../../src/tracking/config.ts";

test("T2 tracking configuration defaults to disabled when the deployment configures nothing", () => {
  assert.deepEqual(readTrackingConfig({}), {
    desiredMode: "disabled",
    containerId: null,
  });
});

test("T2 tracking configuration fails closed on a malformed desired mode", () => {
  for (const desired of ["LIVE", "live ", " live", "enabled", "preview;live"]) {
    assert.throws(
      () => readTrackingConfig({ LA_TRACKING_MODE: desired }),
      /LA_TRACKING_MODE/,
      `${JSON.stringify(desired)} must fail closed`,
    );
  }
});

test("T2 a malformed desired mode never echoes hostile configuration back", () => {
  const hostile = "live'><script>alert(1)</script>";
  try {
    readTrackingConfig({ LA_TRACKING_MODE: hostile });
    assert.fail("expected malformed tracking mode to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes(hostile), false);
    assert.equal(message.includes("<script>"), false);
  }
});

test("T2 preview and live require a well-formed GTM container id", () => {
  for (const desiredMode of ["preview", "live"]) {
    assert.throws(
      () => readTrackingConfig({ LA_TRACKING_MODE: desiredMode }),
      /LA_GTM_CONTAINER_ID/,
      `${desiredMode} must require a container id`,
    );

    for (const containerId of ["GTM", "gtm-abc123", "GTM-", "GTM-ABC 123", " GTM-ABC123"]) {
      assert.throws(
        () =>
          readTrackingConfig({
            LA_TRACKING_MODE: desiredMode,
            LA_GTM_CONTAINER_ID: containerId,
          }),
        /LA_GTM_CONTAINER_ID/,
        `${containerId} must be rejected for ${desiredMode}`,
      );
    }

    assert.deepEqual(
      readTrackingConfig({
        LA_TRACKING_MODE: desiredMode,
        LA_GTM_CONTAINER_ID: "GTM-ABC123",
      }),
      { desiredMode, containerId: "GTM-ABC123" },
    );
  }
});

test("T2 disabled is a safe kill switch: a configured container id is ignored, never an error", () => {
  const closed = { desiredMode: "disabled", containerId: null };
  assert.deepEqual(
    readTrackingConfig({ LA_TRACKING_MODE: "disabled", LA_GTM_CONTAINER_ID: "GTM-ABC123" }),
    closed,
  );
  // Even a malformed id cannot turn the switch into an outage.
  assert.deepEqual(
    readTrackingConfig({ LA_TRACKING_MODE: "disabled", LA_GTM_CONTAINER_ID: "not-an-id" }),
    closed,
  );
});

test("T2 a blank mode, as written by `LA_TRACKING_MODE=` in an env file, is the disabled default", () => {
  const closed = { desiredMode: "disabled", containerId: null };
  assert.deepEqual(readTrackingConfig({ LA_TRACKING_MODE: "" }), closed);
  assert.deepEqual(readTrackingConfig({ LA_TRACKING_MODE: "   " }), closed);
  assert.deepEqual(readTrackingConfig({ LA_TRACKING_MODE: "", LA_GTM_CONTAINER_ID: "GTM-ABC123" }), closed);
  // A non-empty unknown value is still a deployment mistake.
  assert.throws(() => readTrackingConfig({ LA_TRACKING_MODE: "lve" }), /LA_TRACKING_MODE/);
});

test("T2 desired live can never come from client, Host or public build input", () => {
  const clientControlled = {
    NEXT_PUBLIC_LA_TRACKING_MODE: "live",
    NEXT_PUBLIC_LA_GTM_CONTAINER_ID: "GTM-ABC123",
    HOST: "shop.example.com",
    "x-forwarded-host": "shop.example.com",
    la_tracking_mode: "live",
  };

  assert.deepEqual(readTrackingConfig(clientControlled), {
    desiredMode: "disabled",
    containerId: null,
  });
});

test("T3 requested preview and live still resolve to no GTM load before T8", () => {
  for (const desiredMode of TRACKING_MODES) {
    const config =
      desiredMode === "disabled"
        ? { desiredMode, containerId: null }
        : { desiredMode, containerId: "GTM-ABC123" };
    const runtime = resolveTrackingRuntime(config);

    assert.equal(runtime.mode, desiredMode, `${desiredMode} must stay the reported mode`);
    assert.equal(
      runtime.loadsGoogleTagManager,
      false,
      `${desiredMode} must not load GTM before the reviewed immutable version exists`,
    );
    assert.equal(shouldLoadGoogleTagManager(runtime), false);
  }
});

test("T3 the dataLayer bootstrap is prepared only for an explicitly requested tracking mode", () => {
  assert.equal(
    resolveTrackingRuntime({ desiredMode: "disabled", containerId: null }).publishesDataLayer,
    false,
  );
  for (const desiredMode of ["preview", "live"] as const) {
    assert.equal(
      resolveTrackingRuntime({ desiredMode, containerId: "GTM-ABC123" }).publishesDataLayer,
      true,
    );
  }
});
