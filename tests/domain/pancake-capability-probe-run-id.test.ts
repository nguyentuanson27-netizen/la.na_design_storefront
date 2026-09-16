import assert from "node:assert/strict";
import test from "node:test";

import { createProbeRunId } from "../../src/integrations/pancake/capability-probe.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("Pancake capability probe run ids use collision-resistant UUIDs", () => {
  const runIds = Array.from({ length: 32 }, () => createProbeRunId());

  assert.equal(new Set(runIds).size, runIds.length);
  for (const runId of runIds) {
    assert.match(runId, UUID_PATTERN);
  }
});
