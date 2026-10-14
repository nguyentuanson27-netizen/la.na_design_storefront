import assert from "node:assert/strict";
import test from "node:test";

import { PancakeHttpError } from "../../src/integrations/pancake/client.ts";
import {
  assertProbeApproved,
  buildProbeOrderInput,
  compareReadBack,
  parseProbeSelection,
  PROBE_APPROVAL_ENV,
  PROBE_CASE_IDS,
  PROBE_CASES,
  PROBE_CASES_ENV,
  PROBE_PRODUCT_CODE_ENV,
  PROBE_VARIATION_ENV,
  readBackOrderLines,
  runCapabilityProbe,
  sumMerchandiseVnd,
  validateProbeVariation,
  type ReadBackLine,
} from "../../scripts/pancake-gift-quantity-capability-probe.ts";
import type { ControlledAcceptanceClient } from "../../scripts/pancake-p10-custom-price-acceptance.ts";

const VARIATION = "11111111-2222-3333-4444-555555555555";
const SHOP_ID = 920007;
const API_KEY = "super-secret-api-key";

type Item = { variation_id: string; quantity: number; variation_info: { retail_price: number } };
type PostedBody = { items: Item[] };
type PosBehavior = "faithful" | "merge-average" | "reject" | "network" | "no-id" | "readback-fails" | "cancel-fails" | "cancel-unexpected-body" | "cancel-ack-not-applied" | "cancel-contradicts" | "cancel-readback-fails";

function fakePos(behavior: PosBehavior, stock = 10) {
  const calls: string[] = [];
  const orders = new Map<number, Item[]>();
  const statuses = new Map<number, number>();
  let cancelRequested = false;
  let nextId = 5000;
  const client: ControlledAcceptanceClient = {
    async getJson(endpoint) {
      calls.push(`GET ${endpoint}`);
      if (endpoint.endsWith("/products/variations")) {
        return { data: [{ id: VARIATION, remain_quantity: stock }] };
      }
      const id = Number(endpoint.split("/").pop());
      // the order cannot be read before the cancel; once cancelled the read-back works again
      if (behavior === "readback-fails" && !cancelRequested) throw new Error("boom");
      const items = orders.get(id);
      if (!items) throw new Error("not found");
      if (behavior === "cancel-readback-fails" && cancelRequested) throw new Error("503 read-back unavailable");
      const total = items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
      return { data: { total_price: total, shipping_fee: 30_000, status: statuses.get(id) ?? 0, items } };
    },
    async postJson(endpoint, body) {
      calls.push(`POST ${endpoint}`);
      if (behavior === "reject") throw new PancakeHttpError(422, endpoint);
      if (behavior === "network") throw new Error("socket hang up");
      if (behavior === "no-id") return { success: true };
      const posted = (body as PostedBody).items;
      let stored: Item[] = posted;
      if (behavior === "merge-average") {
        const quantity = posted.reduce((sum, item) => sum + item.quantity, 0);
        const total = posted.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0);
        stored = [
          { variation_id: VARIATION, quantity, variation_info: { retail_price: Math.round(total / quantity) } },
        ];
      }
      const id = nextId++;
      orders.set(id, stored);
      statuses.set(id, 0);
      return { success: true, data: { id } };
    },
    async putJson(endpoint, body) {
      calls.push(`PUT ${endpoint} ${JSON.stringify(body)}`);
      if (behavior === "cancel-fails") throw new Error("503 service unavailable");
      if (behavior === "cancel-unexpected-body") return { success: false };
      cancelRequested = true;
      const id = Number(endpoint.split("/").pop());
      // acknowledges the request without applying it: success:true but the status never becomes 7
      if (behavior === "cancel-ack-not-applied") return { success: true };
      // the body itself names a different status
      if (behavior === "cancel-contradicts") return { success: true, data: { status: 1 } };
      statuses.set(id, 7);
      return { success: true, data: { status: 7 } };
    },
  };
  return { client, calls };
}

function approvedEnv(cases: string, extra: Record<string, string> = {}) {
  return {
    PANCAKE_API_KEY: API_KEY,
    PANCAKE_SHOP_ID: String(SHOP_ID),
    [PROBE_APPROVAL_ENV]: `shop:${SHOP_ID}`,
    [PROBE_CASES_ENV]: cases,
    [PROBE_VARIATION_ENV]: VARIATION,
    [PROBE_PRODUCT_CODE_ENV]: "a132",
    ...extra,
  };
}

const deps = (client: ControlledAcceptanceClient) => ({
  client,
  now: () => new Date("2026-10-13T00:00:00.000Z"),
  newRunId: () => "abcdef1234567890",
});

test("probe case definitions encode EX-17 and the 1.000 VND gift split with exact totals", () => {
  assert.equal(sumMerchandiseVnd(PROBE_CASES.PAID_PAID_DIFFERENT_PRICE.lines), 290_003);
  assert.deepEqual(
    PROBE_CASES.PAID_GIFT_VENDOR_PRICE_SAME_VARIATION.lines.map((line) => line.unitPriceVnd),
    [99_000, 1_000],
  );
  assert.equal(sumMerchandiseVnd(PROBE_CASES.PAID_GIFT_VENDOR_PRICE_SAME_VARIATION.lines), 100_000);
  assert.equal(PROBE_CASES.GIFT_ZERO_PRICE_INFORMATIONAL.gating, false);
  assert.equal(PROBE_CASES.PAID_PAID_DIFFERENT_PRICE.gating, true);
  assert.deepEqual(PROBE_CASE_IDS.length, 3);
});

test("sumMerchandiseVnd rejects invalid and overflowing lines", () => {
  assert.throws(() => sumMerchandiseVnd([{ quantity: 0, unitPriceVnd: 1 }]), RangeError);
  assert.throws(() => sumMerchandiseVnd([{ quantity: 1, unitPriceVnd: -1 }]), RangeError);
  assert.throws(() => sumMerchandiseVnd([{ quantity: 1.5, unitPriceVnd: 1 }]), RangeError);
  assert.throws(
    () => sumMerchandiseVnd([{ quantity: Number.MAX_SAFE_INTEGER, unitPriceVnd: 2 }]),
    RangeError,
  );
});

test("refuses CI and refuses without exact per-shop operator approval", () => {
  assert.throws(
    () => assertProbeApproved({ CI: "true", [PROBE_APPROVAL_ENV]: `shop:${SHOP_ID}` }, SHOP_ID),
    /refuses CI execution/,
  );
  assert.throws(
    () => assertProbeApproved({ GITHUB_ACTIONS: "true", [PROBE_APPROVAL_ENV]: `shop:${SHOP_ID}` }, SHOP_ID),
    /refuses CI execution/,
  );
  assert.throws(() => assertProbeApproved({}, SHOP_ID), /explicit operator approval/);
  assert.throws(
    () => assertProbeApproved({ [PROBE_APPROVAL_ENV]: "shop:1" }, SHOP_ID),
    /explicit operator approval/,
  );
  assert.throws(
    () => assertProbeApproved({ [PROBE_APPROVAL_ENV]: "true" }, SHOP_ID),
    /explicit operator approval/,
  );
  assert.doesNotThrow(() => assertProbeApproved({ [PROBE_APPROVAL_ENV]: `shop:${SHOP_ID}` }, SHOP_ID));
});

test("case selection is explicit, validated and de-duplicated", () => {
  assert.throws(() => parseProbeSelection({}), /must list the case ids/);
  assert.throws(() => parseProbeSelection({ [PROBE_CASES_ENV]: "NOPE" }), /Unknown probe case id/);
  assert.deepEqual(
    parseProbeSelection({ [PROBE_CASES_ENV]: "PAID_PAID_DIFFERENT_PRICE, PAID_PAID_DIFFERENT_PRICE" }),
    ["PAID_PAID_DIFFERENT_PRICE"],
  );
});

test("a refused run makes no network call at all", async () => {
  const { client, calls } = fakePos("faithful");
  await assert.rejects(
    runCapabilityProbe({ ...approvedEnv("PAID_PAID_DIFFERENT_PRICE"), CI: "true" }, deps(client)),
    /refuses CI execution/,
  );
  await assert.rejects(
    runCapabilityProbe({ ...approvedEnv("PAID_PAID_DIFFERENT_PRICE"), [PROBE_APPROVAL_ENV]: "" }, deps(client)),
    /explicit operator approval/,
  );
  assert.deepEqual(calls, []);
});

test("preflight rejects missing variation or insufficient stock before any write", async () => {
  assert.throws(() => validateProbeVariation({ data: [] }, VARIATION, 1), /not found/);
  assert.throws(
    () => validateProbeVariation({ data: [{ id: VARIATION, remain_quantity: 2 }] }, VARIATION, 3),
    /Insufficient sellable stock/,
  );
  const { client, calls } = fakePos("faithful", 2);
  await assert.rejects(
    runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client)),
    /Insufficient sellable stock/,
  );
  assert.equal(calls.some((call) => call.startsWith("POST")), false);
});

test("a faithful POS passes both gating cases, keeps both prices and cancels every order", async () => {
  const { client, calls } = fakePos("faithful");
  const report = await runCapabilityProbe(
    approvedEnv("PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION"),
    deps(client),
  );
  assert.equal(report.allSelectedGatingCasesPassed, true);
  assert.equal(report.runId, "abcdef12");
  const [paidPaid, paidGift] = report.cases;
  assert.equal(paidPaid.outcome, "PASS");
  assert.equal(paidPaid.readBackMerchandiseTotalVnd, 290_003);
  assert.equal(paidPaid.totalMatchesExpected, true);
  assert.equal(paidPaid.cleanupResult, "CANCELED_STATUS_7");
  assert.equal(paidGift.outcome, "PASS");
  assert.deepEqual(
    paidGift.readBackLines.map((line) => line.unitPriceVnd),
    [99_000, 1_000],
  );
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 2);
  assert.equal(calls.filter((call) => call.startsWith("PUT")).length, 2);
});

test("a POS that merges lines and averages the price FAILS the case and is still cancelled", async () => {
  const { client, calls } = fakePos("merge-average");
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client));
  const [entry] = report.cases;
  assert.equal(entry.outcome, "FAIL_LINES_NOT_PRESERVED");
  assert.match(entry.note, /expected 2 x 100001 VND|expected 1 x 90001 VND|unexpected line/);
  assert.equal(report.allSelectedGatingCasesPassed, false);
  assert.equal(entry.cleanupResult, "CANCELED_STATUS_7");
  assert.equal(calls.filter((call) => call.startsWith("PUT")).length, 1);
});

test("an explicit POS rejection is reported as REJECTED_BY_POS and creates nothing to cancel", async () => {
  const { client, calls } = fakePos("reject");
  const report = await runCapabilityProbe(approvedEnv("GIFT_ZERO_PRICE_INFORMATIONAL"), deps(client));
  assert.equal(report.cases[0].outcome, "REJECTED_BY_POS");
  assert.equal(report.cases[0].createdPancakeOrderId, null);
  assert.equal(calls.some((call) => call.startsWith("PUT")), false);
  // informational case only: rejection does not make the gating verdict false
  assert.equal(report.allSelectedGatingCasesPassed, true);
});

test("ambiguous create responses are never retried and stop the run", async () => {
  for (const behavior of ["network", "no-id"] as const) {
    const { client, calls } = fakePos(behavior);
    const report = await runCapabilityProbe(
      approvedEnv("PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION"),
      deps(client),
    );
    assert.equal(report.cases.length, 1, behavior);
    assert.equal(report.cases[0].outcome, "UNKNOWN_RESPONSE");
    assert.match(report.cases[0].note, /Do NOT retry/);
    assert.equal(report.allSelectedGatingCasesPassed, false);
    assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  }
});

test("a read-back failure after creation still cancels the created order", async () => {
  const { client, calls } = fakePos("readback-fails");
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client));
  const [entry] = report.cases;
  assert.equal(entry.outcome, "UNKNOWN_RESPONSE");
  assert.equal(entry.createdPancakeOrderId, "5000");
  assert.equal(entry.cleanupResult, "CANCELED_STATUS_7");
  assert.equal(calls.filter((call) => call.startsWith("PUT")).length, 1);
});

test("the report never contains the API key or customer data beyond fixed test constants", async () => {
  const { client } = fakePos("faithful");
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes("0900000000"), false);
});

test("run id must be short and alphanumeric", async () => {
  const { client } = fakePos("faithful");
  await assert.rejects(
    runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE", { GQ_POS_PROBE_RUN_ID: "bad id!" }), deps(client)),
    /alphanumeric/,
  );
});

test("compareReadBack treats re-ordered lines as preserved and averaged or dropped lines as not", () => {
  const expected: ReadBackLine[] = [
    { variationId: VARIATION, quantity: 2, unitPriceVnd: 100_001 },
    { variationId: VARIATION, quantity: 1, unitPriceVnd: 90_001 },
  ];
  assert.equal(compareReadBack(expected, [...expected].reverse()).preserved, true);
  assert.equal(
    compareReadBack(expected, [{ variationId: VARIATION, quantity: 3, unitPriceVnd: 96_667 }]).preserved,
    false,
  );
  assert.equal(compareReadBack(expected, expected.slice(0, 1)).preserved, false);
  // split in the POS into more lines with the same price is still the same multiset
  assert.equal(
    compareReadBack(expected, [
      { variationId: VARIATION, quantity: 1, unitPriceVnd: 100_001 },
      { variationId: VARIATION, quantity: 1, unitPriceVnd: 100_001 },
      { variationId: VARIATION, quantity: 1, unitPriceVnd: 90_001 },
    ]).preserved,
    true,
  );
});

test("readBackOrderLines rejects malformed payloads", () => {
  assert.throws(() => readBackOrderLines(null), /Invalid order read-back payload/);
  assert.throws(() => readBackOrderLines({ data: {} }), /missing items array/);
  assert.throws(
    () => readBackOrderLines({ data: { items: [{ variation_id: VARIATION, quantity: 1 }] } }),
    /missing variation_id, quantity or retail_price/,
  );
});

test("probe order input is a flagged do-not-ship test order carrying the run id", () => {
  const input = buildProbeOrderInput(SHOP_ID, VARIATION, PROBE_CASES.PAID_PAID_DIFFERENT_PRICE, "run1");
  assert.match(input.note ?? "", /GQ01 run1 PAID_PAID_DIFFERENT_PRICE - DO NOT SHIP/);
  assert.equal(input.lines.every((line) => line.pancakeVariationId === VARIATION), true);
});

test("a case whose test order could not be cancelled is NOT a pass: the run stops, flags cleanup and reports it", async () => {
  for (const behavior of ["cancel-fails", "cancel-unexpected-body"] as const) {
    const { client, calls } = fakePos(behavior);
    const report = await runCapabilityProbe(
      approvedEnv("PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION"),
      deps(client),
    );
    assert.equal(report.cases.length, 1, `${behavior}: no further order is created while one is still open`);
    const [entry] = report.cases;
    assert.equal(entry.outcome, "CLEANUP_NOT_CONFIRMED", behavior);
    assert.notEqual(entry.cleanupResult, "CANCELED_STATUS_7");
    assert.match(entry.note, /cancel it manually/);
    assert.equal(entry.readBackMerchandiseTotalVnd, 290_003, "the read-back evidence is kept for the operator");
    assert.equal(report.noOrderMayBeOpen, false);
    assert.equal(report.allSelectedGatingCasesPassed, false);
    assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  }
});

test("an unconfirmed cancellation after an unknown read-back also stops the run and flags cleanup", async () => {
  const { client } = fakePos("readback-fails");
  const original = client.putJson.bind(client);
  client.putJson = async () => { throw new Error("timeout"); };
  void original;
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION"), deps(client));
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].outcome, "UNKNOWN_RESPONSE");
  assert.equal(report.noOrderMayBeOpen, false);
  assert.equal(report.allSelectedGatingCasesPassed, false);
});

test("a clean run reports every created order cleaned up", async () => {
  const { client } = fakePos("faithful");
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client));
  assert.equal(report.noOrderMayBeOpen, true);
});

test("R01: a create that times out or returns no id leaves an unknown order — never reported as clean, even for an informational case", async () => {
  for (const behavior of ["network", "no-id"] as const) {
    for (const caseId of ["PAID_PAID_DIFFERENT_PRICE", "GIFT_ZERO_PRICE_INFORMATIONAL"] as const) {
      const { client } = fakePos(behavior);
      const report = await runCapabilityProbe(approvedEnv(caseId), deps(client));
      const [entry] = report.cases;
      assert.equal(entry.orderState, "CREATION_UNKNOWN", `${behavior}/${caseId}`);
      assert.equal(entry.createdPancakeOrderId, null);
      assert.equal(report.noOrderMayBeOpen, false, `${behavior}/${caseId}: an order may exist`);
      // the informational case does not gate the verdict, but it must still not look like a clean success
      assert.equal(report.allSelectedGatingCasesPassed, false);
    }
  }
});

test("R01: only an explicit POS refusal means nothing was created; a proven cancel means nothing is open", async () => {
  const rejected = fakePos("reject");
  const refusedReport = await runCapabilityProbe(approvedEnv("GIFT_ZERO_PRICE_INFORMATIONAL"), deps(rejected.client));
  assert.equal(refusedReport.cases[0].orderState, "NOT_CREATED");
  assert.equal(refusedReport.noOrderMayBeOpen, true);
  assert.equal(refusedReport.allSelectedGatingCasesPassed, true, "a refused informational case is a valid, closed result");

  const faithful = fakePos("faithful");
  const okReport = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(faithful.client));
  assert.equal(okReport.cases[0].orderState, "CREATED_CANCELLED");
  assert.equal(okReport.noOrderMayBeOpen, true);
});

test("R01: an unknown creation stops the run before any further order, and a 5xx is unknown, not a refusal", async () => {
  const { client, calls } = fakePos("network");
  const report = await runCapabilityProbe(approvedEnv("GIFT_ZERO_PRICE_INFORMATIONAL,PAID_PAID_DIFFERENT_PRICE"), deps(client));
  assert.equal(report.cases.length, 1);
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  const server = fakePos("faithful");
  const original = server.client.postJson.bind(server.client);
  server.client.postJson = async () => { throw new PancakeHttpError(503, "/orders"); };
  void original;
  const fiveHundred = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(server.client));
  assert.equal(fiveHundred.cases[0].orderState, "CREATION_UNKNOWN");
  assert.equal(fiveHundred.cases[0].outcome, "UNKNOWN_RESPONSE");
});

test("R02: success=true from the cancel call is not proof — the order is read back and must report status 7", async () => {
  const proofs: Array<[PosBehavior, RegExp]> = [
    ["cancel-ack-not-applied", /^CANCEL_NOT_VERIFIED_STATUS_0$/],
    ["cancel-contradicts", /^CANCEL_RESPONSE_STATUS_1$/],
    ["cancel-readback-fails", /^CANCEL_NOT_VERIFIED_READBACK_FAILED$/],
  ];
  for (const [behavior, expected] of proofs) {
    const { client } = fakePos(behavior);
    const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION"), deps(client));
    const [entry] = report.cases;
    assert.match(entry.cleanupResult, expected, behavior);
    assert.equal(entry.outcome, "CLEANUP_NOT_CONFIRMED", behavior);
    assert.equal(entry.orderState, "CREATED_CLEANUP_UNCONFIRMED");
    assert.equal(report.cases.length, 1, `${behavior}: the run stops with an order still open`);
    assert.equal(report.noOrderMayBeOpen, false);
    assert.equal(report.allSelectedGatingCasesPassed, false);
  }
});

test("R02: a faithful cancel is confirmed only by the read-back (status 7), and the cancel is read before it is trusted", async () => {
  const { client, calls } = fakePos("faithful");
  const report = await runCapabilityProbe(approvedEnv("PAID_PAID_DIFFERENT_PRICE"), deps(client));
  assert.equal(report.cases[0].cleanupResult, "CANCELED_STATUS_7");
  const putAt = calls.findIndex((call) => call.startsWith("PUT"));
  assert.ok(calls.slice(putAt + 1).some((call) => call.startsWith("GET /shops") && call.includes("/orders/")), "a read-back follows the PUT");
});
