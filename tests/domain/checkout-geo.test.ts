import assert from "node:assert/strict";
import test from "node:test";

import { loadCheckoutCommunes, loadCheckoutProvinces } from "../../src/commerce/checkout-geo.ts";

type Query = Readonly<Record<string, string | number | boolean>>;

class FakeReadableClient {
  readonly calls: Array<{ endpoint: string; query: Query }> = [];
  private readonly payloads: unknown[];

  constructor(...payloads: unknown[]) {
    this.payloads = payloads;
  }

  async getJson(endpoint: string, query: Query = {}): Promise<unknown> {
    this.calls.push({ endpoint, query });
    return this.payloads.shift();
  }
}

test("checkout offers the post-2025 provinces", async () => {
  const client = new FakeReadableClient({
    data: [
      { id: "84_VN101", name: "Thành phố Hà Nội" },
      { id: "84_VN701", name: "Thành phố Hồ Chí Minh", name_en: "Ho Chi Minh City" },
    ],
  });

  assert.deepEqual(await loadCheckoutProvinces(client), [
    { id: "84_VN101", name: "Thành phố Hà Nội" },
    { id: "84_VN701", name: "Thành phố Hồ Chí Minh" },
  ]);
  assert.deepEqual(client.calls, [
    { endpoint: "/geo/provinces", query: { country_code: "84", is_new: true } },
  ]);
});

test("checkout lists wards/communes straight under the province, with no district", async () => {
  const client = new FakeReadableClient({
    data: [
      { id: "84_VN10105", name: "Phường Cầu Giấy", province_id: "84_VN101", district_id: null },
      { id: "84_VN10109", name: "Phường Nghĩa Đô" },
    ],
  });

  assert.deepEqual(await loadCheckoutCommunes(client, "84_VN101"), [
    { id: "84_VN10105", name: "Phường Cầu Giấy", provinceId: "84_VN101" },
    { id: "84_VN10109", name: "Phường Nghĩa Đô", provinceId: "84_VN101" },
  ]);
  assert.deepEqual(client.calls, [
    { endpoint: "/geo/communes", query: { province_id: "84_VN101" } },
  ]);
});

test("checkout refuses old three-level or wrong-province commune rows instead of mixing them in", async () => {
  await assert.rejects(
    loadCheckoutCommunes(
      new FakeReadableClient({
        data: [{ id: "1011309", name: "Phường Dịch Vọng", province_id: "84_VN101", district_id: "10113" }],
      }),
      "84_VN101",
    ),
    /MALFORMED_GEO_RESPONSE/,
  );
  await assert.rejects(
    loadCheckoutCommunes(
      new FakeReadableClient({
        data: [{ id: "84_VN70101", name: "Phường Bến Nghé", province_id: "84_VN701" }],
      }),
      "84_VN101",
    ),
    /MALFORMED_GEO_RESPONSE/,
  );
});

test("checkout geo rejects a non-string province id before any Pancake read", async () => {
  const client = new FakeReadableClient({ data: [] });

  await assert.rejects(() => loadCheckoutCommunes(client, 101));
  await assert.rejects(() => loadCheckoutCommunes(client, null));
  assert.equal(client.calls.length, 0);
});
