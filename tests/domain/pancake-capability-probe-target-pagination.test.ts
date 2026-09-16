import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZED_CODES,
  AUTHORIZED_SHOP_ID,
  CapabilityProbeGuardError,
  discoverAndValidateProbeTargets,
  type ProbeApiClient,
} from "../../src/integrations/pancake/capability-probe.ts";

type JsonRecord = Record<string, unknown>;

type VariationPage = {
  data: JsonRecord[];
  total_pages?: unknown;
};

const IDS = {
  ordinary: "var-v8014-s",
  parent: "var-sv1683-s",
  ao: "var-sv1683-ao-s",
  vay: "var-sv1683-vay-s",
  warehouse: "wh-test",
} as const;

function authorizedVariations(): JsonRecord[] {
  const wh = [{ warehouse_id: IDS.warehouse, remain_quantity: 1 }];
  return [
    {
      id: IDS.ordinary,
      product_id: "prod-v8014",
      display_id: "V8014-S",
      product: { id: "prod-v8014", display_id: AUTHORIZED_CODES.ORDINARY },
      is_composite: false,
      variations_warehouses: wh,
    },
    {
      id: IDS.parent,
      product_id: "prod-parent",
      display_id: AUTHORIZED_CODES.COMPOSITE_PARENT,
      product: { id: "prod-parent", display_id: "SV1683" },
      is_composite: true,
      variations_warehouses: wh,
      composite_products: [
        { component_id: IDS.ao, quantity: 1, component: { id: IDS.ao } },
        { component_id: IDS.vay, quantity: 1, component: { id: IDS.vay } },
      ],
    },
    {
      id: IDS.ao,
      product_id: "prod-ao",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_AO,
      product: { id: "prod-ao", display_id: "SV1683-AO" },
      is_composite: false,
      variations_warehouses: wh,
    },
    {
      id: IDS.vay,
      product_id: "prod-vay",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY,
      product: { id: "prod-vay", display_id: "SV1683-VAY" },
      is_composite: false,
      variations_warehouses: wh,
    },
  ];
}

function discoveryClient(
  pageFor: (page: number) => VariationPage,
  onRequest?: (page: number) => void,
): ProbeApiClient {
  return {
    async getJson(endpoint, query = {}) {
      if (!endpoint.includes("/products/variations")) {
        throw new Error(`Unexpected GET ${endpoint}`);
      }
      const page = Number(query.page_number ?? 1);
      onRequest?.(page);
      return pageFor(page);
    },
    async postJson(endpoint) {
      throw new Error(`Unexpected POST ${endpoint}`);
    },
    async putJson(endpoint) {
      throw new Error(`Unexpected PUT ${endpoint}`);
    },
  };
}

async function expectPaginationGuard(
  pageFor: (page: number) => VariationPage,
  expectedRequests: number,
): Promise<void> {
  let requests = 0;
  await assert.rejects(
    () =>
      discoverAndValidateProbeTargets(
        discoveryClient(pageFor, () => {
          requests += 1;
        }),
        AUTHORIZED_SHOP_ID,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityProbeGuardError);
      assert.match(error.message, /pagination|page cap/i);
      return true;
    },
  );
  assert.equal(requests, expectedRequests);
}

test("variation discovery rejects oversized total_pages before requesting another page", async () => {
  await expectPaginationGuard(() => ({ data: [], total_pages: 11 }), 1);
});

test("variation discovery rejects non-finite total_pages before requesting another page", async () => {
  await expectPaginationGuard(() => ({ data: [], total_pages: Number.POSITIVE_INFINITY }), 1);
});

test("variation discovery rejects fractional total_pages before requesting another page", async () => {
  await expectPaginationGuard(() => ({ data: [], total_pages: 1.5 }), 1);
});

test("variation discovery rejects contradictory total_pages across pages", async () => {
  await expectPaginationGuard(
    (page) => ({ data: [], total_pages: page === 1 ? 2 : 1 }),
    2,
  );
});

test("variation discovery without pagination metadata stops at the bounded page cap", async () => {
  const fullPage = Array.from({ length: 50 }, (_, index) => ({
    id: `dummy-${index}`,
    display_id: `DUMMY-${index}`,
  }));
  await expectPaginationGuard(() => ({ data: fullPage }), 10);
});

test("variation discovery accepts consistent bounded multi-page metadata", async () => {
  const source = authorizedVariations();
  let requests = 0;
  const targets = await discoverAndValidateProbeTargets(
    discoveryClient(
      (page) => ({
        data: page === 1 ? source.slice(0, 2) : source.slice(2),
        total_pages: 2,
      }),
      () => {
        requests += 1;
      },
    ),
    AUTHORIZED_SHOP_ID,
  );
  assert.equal(requests, 2);
  assert.equal(targets.ordinary.variationId, IDS.ordinary);
  assert.equal(targets.compositeParent.variationId, IDS.parent);
});
