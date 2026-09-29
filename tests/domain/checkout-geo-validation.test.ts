import assert from "node:assert/strict";
import test from "node:test";

import { validateCheckoutGeoSelection } from "../../src/commerce/checkout-geo-validation.ts";

const rawInput = {
  name: " Nguyễn Văn A ",
  phone: " 0901 234 567 ",
  provinceRef: "84_VN101",
  communeRef: "84_VN10105",
  detail: " 12 Đường A ",
  note: " giao giờ hành chính ",
};

function createDependencies(overrides: Partial<{
  provinces: unknown[];
  communes: unknown[];
}> = {}) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      async loadProvinces() {
        calls.push("provinces");
        return (overrides.provinces ?? [{ id: "84_VN101", name: "Thành phố Hà Nội" }]) as never;
      },
      async loadCommunes(provinceId: unknown) {
        calls.push(`communes:${String(provinceId)}`);
        return (overrides.communes ?? [
          { id: "84_VN10105", name: "Phường Cầu Giấy", provinceId: "84_VN101" },
        ]) as never;
      },
    },
  };
}

test("checkout geo validation accepts a province → ward/commune pair and returns normalized input", async () => {
  const { calls, dependencies } = createDependencies();

  assert.deepEqual(await validateCheckoutGeoSelection(dependencies, rawInput), {
    ok: true,
    checkoutInput: {
      name: "Nguyễn Văn A",
      phone: "0901234567",
      provinceRef: "84_VN101",
      districtRef: null,
      communeRef: "84_VN10105",
      detail: "12 Đường A",
      note: "giao giờ hành chính",
    },
  });
  assert.deepEqual(calls, ["provinces", "communes:84_VN101"]);
});

test("checkout geo validation reads both levels together but judges them top-down", async () => {
  const unknownProvince = createDependencies({ provinces: [] });
  assert.deepEqual(
    await validateCheckoutGeoSelection(unknownProvince.dependencies, rawInput),
    { ok: false, reason: "INVALID_INPUT" },
  );
  assert.deepEqual(unknownProvince.calls, ["provinces", "communes:84_VN101"]);

  const unknownCommune = createDependencies({ communes: [] });
  assert.deepEqual(
    await validateCheckoutGeoSelection(unknownCommune.dependencies, rawInput),
    { ok: false, reason: "INVALID_INPUT" },
  );
});

test("an invalid phone is reported as such before any geo read", async () => {
  const { calls, dependencies } = createDependencies();

  assert.deepEqual(
    await validateCheckoutGeoSelection(dependencies, { ...rawInput, phone: "12345" }),
    { ok: false, reason: "INVALID_PHONE" },
  );
  assert.deepEqual(calls, []);
});

test("malformed checkout input is rejected before any geo read", async () => {
  const { calls, dependencies } = createDependencies();

  for (const input of [
    { ...rawInput, provinceRef: " " },
    { ...rawInput, communeRef: "" },
    { ...rawInput, detail: "" },
  ]) {
    assert.deepEqual(await validateCheckoutGeoSelection(dependencies, input), {
      ok: false,
      reason: "INVALID_INPUT",
    });
  }
  assert.deepEqual(calls, []);
});

test("geo dependency failures propagate instead of being misclassified as invalid user input", async () => {
  const outage = new Error("Pancake unavailable");
  const dependencies = {
    async loadProvinces(): Promise<never> {
      throw outage;
    },
    async loadCommunes(): Promise<never> {
      throw new Error("unreachable");
    },
  };

  await assert.rejects(
    () => validateCheckoutGeoSelection(dependencies, rawInput),
    (error: unknown) => error === outage,
  );
});

test("an unknown province is invalid input even when the commune read below it fails", async () => {
  const dependencies = {
    async loadProvinces() {
      return [{ id: "84_VN999", name: "Elsewhere" }] as never;
    },
    async loadCommunes(): Promise<never> {
      throw new Error("Pancake refused the unknown province id");
    },
  };

  assert.deepEqual(await validateCheckoutGeoSelection(dependencies, rawInput), {
    ok: false,
    reason: "INVALID_INPUT",
  });
});

test("checkout geo reads run concurrently rather than one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  async function read<T>(value: T): Promise<T> {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value;
  }
  const dependencies = {
    loadProvinces: () => read([{ id: "84_VN101", name: "Hà Nội" }] as never),
    loadCommunes: () =>
      read([{ id: "84_VN10105", name: "Cầu Giấy", provinceId: "84_VN101" }] as never),
  };

  assert.equal((await validateCheckoutGeoSelection(dependencies, rawInput)).ok, true);
  assert.equal(peak, 2);
});
