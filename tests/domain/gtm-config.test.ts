import assert from "node:assert/strict";
import test from "node:test";

import { readGtmConfig } from "../../src/integrations/gtm/config.ts";

test("readGtmConfig treats an empty public id as unset and falls back to the server id", () => {
  const config = readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "", LA_GTM_CONTAINER_ID: "GTM-ABC123" });
  assert.equal(config?.containerId, "GTM-ABC123");
});

test("readGtmConfig prefers a configured public id and accepts it alone", () => {
  assert.equal(readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "GTM-ABC123" })?.containerId, "GTM-ABC123");
  assert.equal(
    readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "GTM-ABC123", LA_GTM_CONTAINER_ID: "GTM-ABC123" })
      ?.containerId,
    "GTM-ABC123",
  );
});

test("readGtmConfig fails closed on conflicting, malformed or absent ids", () => {
  assert.equal(
    readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "GTM-ABC123", LA_GTM_CONTAINER_ID: "GTM-ZZZ999" }),
    null,
  );
  assert.equal(readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "not-a-container" }), null);
  assert.equal(readGtmConfig({ NEXT_PUBLIC_GTM_CONTAINER_ID: "", LA_GTM_CONTAINER_ID: "" }), null);
  assert.equal(readGtmConfig({}), null);
});
