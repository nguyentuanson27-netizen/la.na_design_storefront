import assert from "node:assert/strict";
import test from "node:test";

import { createCheckoutGeoPublicActions } from "../../src/commerce/checkout-geo-public-actions.ts";

const provinces = [
  { id: "84_VN101", name: "Thành phố Hà Nội" },
  { id: "84_VN701", name: "Thành phố Hồ Chí Minh" },
];
const communes = [{ id: "84_VN10105", name: "Phường Cầu Giấy", provinceId: "84_VN101" }];

test("checkout geo public actions authorize each read, return allowlisted options, and preserve the parent id", async () => {
  const calls: unknown[] = [];
  const dependencies = {
    allowRead: async () => {
      calls.push(["allow"]);
      return true;
    },
    loadProvinces: async () => provinces,
    loadCommunes: async (provinceId: unknown) => {
      calls.push(["communes", provinceId]);
      return communes;
    },
  };
  const actions = createCheckoutGeoPublicActions(dependencies);

  assert.deepEqual(await actions.provinces(), { ok: true, options: provinces });
  assert.deepEqual(await actions.communes("84_VN101"), { ok: true, options: communes });
  assert.deepEqual(calls, [["allow"], ["allow"], ["communes", "84_VN101"]]);
});

test("checkout geo public actions fail closed with one fixed browser reason", async () => {
  const secret = "pancake-secret-must-not-escape";
  const dependencies = {
    allowRead: async () => true,
    loadProvinces: async () => {
      throw new Error(`network failed with ${secret}`);
    },
    loadCommunes: async () => {
      throw new Error(`malformed response ${secret}`);
    },
  };
  const actions = createCheckoutGeoPublicActions(dependencies);

  for (const result of [await actions.provinces(), await actions.communes("84_VN101")]) {
    assert.deepEqual(result, { ok: false, reason: "GEO_UNAVAILABLE" });
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("checkout geo public actions deny rate-limited reads before Pancake loaders", async () => {
  let upstreamCalls = 0;
  const dependencies = {
    allowRead: async () => false,
    loadProvinces: async () => {
      upstreamCalls += 1;
      return provinces;
    },
    loadCommunes: async () => {
      upstreamCalls += 1;
      return communes;
    },
  };
  const actions = createCheckoutGeoPublicActions(dependencies);

  assert.deepEqual(await actions.provinces(), { ok: false, reason: "GEO_UNAVAILABLE" });
  assert.deepEqual(await actions.communes("84_VN101"), {
    ok: false,
    reason: "GEO_UNAVAILABLE",
  });
  assert.equal(upstreamCalls, 0);
});
