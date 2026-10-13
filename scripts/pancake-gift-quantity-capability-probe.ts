import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PancakeClient, PancakeHttpError } from "../src/integrations/pancake/client.ts";
import { readPancakeConfig } from "../src/integrations/pancake/config.ts";
import {
  buildPancakeCreateOrderRequest,
  type PancakeCreateOrderInput,
} from "../src/integrations/pancake/order-create.ts";
import {
  CI_REFUSAL_MESSAGE,
  environmentFlagIsEnabled,
  extractCreatedOrderId,
  sanitizeCleanupErrorMessage,
  TEST_ADDRESS_DETAIL,
  TEST_COMMUNE_ID,
  TEST_CUSTOMER_NAME,
  TEST_CUSTOMER_PHONE,
  TEST_DISTRICT_ID,
  TEST_PROVINCE_ID,
  TEST_SHIPPING_FEE_VND,
  type ControlledAcceptanceClient,
} from "./pancake-p10-custom-price-acceptance.ts";

/**
 * Gift & Quantity Promotions v1 (GQ01): controlled Pancake POS capability probe.
 *
 * It answers one question per case -- does the POS API accept and preserve the line shape the
 * storefront needs? -- and never infers vendor support from types or from the P10 evidence (which
 * only proved one positive custom price on one line per variation).
 *
 * Safety model (see docs/integrations/pancake-gift-quantity-acceptance.md):
 * - refuses CI, refuses without explicit operator approval for the exact shop and case list;
 * - one create attempt per case, never an automatic retry (Pancake has no idempotency key);
 * - the order that was created is cancelled on every exit path;
 * - the report is sanitized: no API key, no customer data beyond the fixed test constants.
 *
 * Nothing here runs from the test suite against the network; tests inject a fake client.
 */

export const PROBE_APPROVAL_ENV = "GQ_POS_PROBE_APPROVED";
export const PROBE_CASES_ENV = "GQ_POS_PROBE_CASES";
export const PROBE_VARIATION_ENV = "GQ_POS_PROBE_VARIATION_ID";
export const PROBE_PRODUCT_CODE_ENV = "GQ_POS_PROBE_PRODUCT_CODE";
export const PROBE_RUN_ID_ENV = "GQ_POS_PROBE_RUN_ID";

export const PROBE_CASE_IDS = [
  "PAID_PAID_DIFFERENT_PRICE",
  "PAID_GIFT_VENDOR_PRICE_SAME_VARIATION",
  "GIFT_ZERO_PRICE_INFORMATIONAL",
] as const;
export type ProbeCaseId = (typeof PROBE_CASE_IDS)[number];

export type ProbeLine = Readonly<{ quantity: number; unitPriceVnd: number }>;

export type ProbeCaseDefinition = Readonly<{
  id: ProbeCaseId;
  /** Spec reference and why the case exists. */
  purpose: string;
  /** Every line uses the SAME Pancake variation; that is the point of the case. */
  lines: readonly ProbeLine[];
  /** false for cases whose outcome does not gate the build (informational). */
  gating: boolean;
}>;

/**
 * EX-17: 2 x 100.001 + 1 x 90.001 = 290.003 (PAID+PAID, same variation, different price).
 * D-08 / ADR 0016: a gift unit is sent at 1.000 VND and the same amount is deducted from the paid goods,
 * so a paid unit of 100.000 becomes 99.000 beside a gift of 1.000 -- the order total stays 100.000.
 * The 0 VND gift is no longer needed by the flow and runs only when explicitly selected.
 */
export const PROBE_CASES: Readonly<Record<ProbeCaseId, ProbeCaseDefinition>> = Object.freeze({
  PAID_PAID_DIFFERENT_PRICE: {
    id: "PAID_PAID_DIFFERENT_PRICE",
    purpose: "EX-17: two PAID lines of one variation with different unit prices keep both prices",
    lines: [
      { quantity: 2, unitPriceVnd: 100_001 },
      { quantity: 1, unitPriceVnd: 90_001 },
    ],
    gating: true,
  },
  PAID_GIFT_VENDOR_PRICE_SAME_VARIATION: {
    id: "PAID_GIFT_VENDOR_PRICE_SAME_VARIATION",
    purpose: "D-08: PAID(P-1.000) and GIFT(1.000) lines of one variation keep both prices; total stays P",
    lines: [
      { quantity: 1, unitPriceVnd: 99_000 },
      { quantity: 1, unitPriceVnd: 1_000 },
    ],
    gating: true,
  },
  GIFT_ZERO_PRICE_INFORMATIONAL: {
    id: "GIFT_ZERO_PRICE_INFORMATIONAL",
    purpose: "Informational: does the POS accept a 0 VND line (not required by the 1.000 VND flow)",
    lines: [
      { quantity: 1, unitPriceVnd: 100_000 },
      { quantity: 1, unitPriceVnd: 0 },
    ],
    gating: false,
  },
});

export type ProbeOutcome =
  | "PASS"
  | "FAIL_LINES_NOT_PRESERVED"
  | "REJECTED_BY_POS"
  | "UNKNOWN_RESPONSE"
  /** The case ran, but the order it created was not confirmed cancelled. Never a pass. */
  | "CLEANUP_NOT_CONFIRMED";

/** The only cancellation result that proves the test order is closed. */
export const CLEANUP_CONFIRMED = "CANCELED_STATUS_7";

/**
 * What is known about the order a case may have created. "No order id came back" is NOT "no order":
 * a timeout or a response without an id can hide an order that exists.
 */
export type ProbeOrderState =
  /** The POS refused the request outright (HTTP 4xx): nothing was created. */
  | "NOT_CREATED"
  /** Created, then cancelled and read back as status 7. */
  | "CREATED_CANCELLED"
  /** Created, but the cancellation could not be proven. An open test order exists. */
  | "CREATED_CLEANUP_UNCONFIRMED"
  /** The create call gave no definite answer. An order may exist and nobody knows its id. */
  | "CREATION_UNKNOWN";

export type ProbeCaseReport = Readonly<{
  caseId: ProbeCaseId;
  gating: boolean;
  outcome: ProbeOutcome;
  requestedLines: readonly ProbeLine[];
  expectedMerchandiseTotalVnd: number;
  readBackLines: readonly (ProbeLine & { variationId: string })[];
  readBackMerchandiseTotalVnd: number | null;
  orderTotalPriceVnd: number | null;
  totalMatchesExpected: boolean;
  createdPancakeOrderId: string | null;
  orderState: ProbeOrderState;
  cleanupResult: string;
  note: string;
}>;

export type ProbeReport = Readonly<{
  runId: string;
  timestamp: string;
  shopId: number;
  variationId: string;
  cases: readonly ProbeCaseReport[];
  /**
   * true only when every selected gating case passed AND every order the run created was confirmed
   * cancelled. Says nothing about unselected cases.
   */
  allSelectedGatingCasesPassed: boolean;
  /**
   * false unless every case either created nothing (explicitly refused) or created an order that
   * was proven cancelled. An unknown create, or a cancellation that could not be proven, makes it
   * false even for an informational case: the operator must find and close the order by hand.
   */
  noOrderMayBeOpen: boolean;
}>;

export type ProbeEnvironment = Readonly<Record<string, string | undefined>>;

export function sumMerchandiseVnd(lines: readonly ProbeLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError("Probe line quantity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(line.unitPriceVnd) || line.unitPriceVnd < 0) {
      throw new RangeError("Probe line price must be a non-negative safe integer");
    }
    total += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(total)) throw new RangeError("Probe total overflow");
  }
  return total;
}

export function parseProbeSelection(env: ProbeEnvironment): readonly ProbeCaseId[] {
  const raw = env[PROBE_CASES_ENV]?.trim();
  if (!raw) {
    throw new Error(`${PROBE_CASES_ENV} must list the case ids to run (comma separated)`);
  }
  const selected: ProbeCaseId[] = [];
  for (const part of raw.split(",").map((value) => value.trim())) {
    if (!(PROBE_CASE_IDS as readonly string[]).includes(part)) {
      throw new Error(`Unknown probe case id: ${part}`);
    }
    if (!selected.includes(part as ProbeCaseId)) selected.push(part as ProbeCaseId);
  }
  return selected;
}

export function assertProbeApproved(env: ProbeEnvironment, shopId: number): void {
  if (environmentFlagIsEnabled(env.CI) || environmentFlagIsEnabled(env.GITHUB_ACTIONS)) {
    throw new Error(CI_REFUSAL_MESSAGE);
  }
  const expected = `shop:${shopId}`;
  if (env[PROBE_APPROVAL_ENV] !== expected) {
    throw new Error(
      `Gift/quantity POS probe requires explicit operator approval for this shop: ${PROBE_APPROVAL_ENV}=${expected}`,
    );
  }
}

type VariationRecord = Readonly<{ id: string; remain_quantity: number }>;

export function validateProbeVariation(
  payload: unknown,
  variationId: string,
  requiredStock: number,
): VariationRecord {
  if (!payload || typeof payload !== "object") throw new Error("Invalid Pancake variations payload");
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Invalid Pancake variations payload: missing data array");
  const match = data.find(
    (item) => item !== null && typeof item === "object" && (item as { id?: unknown }).id === variationId,
  ) as { id: string; remain_quantity?: unknown } | undefined;
  if (!match) throw new Error(`Probe variation ${variationId} not found in catalog`);
  if (typeof match.remain_quantity !== "number" || match.remain_quantity < requiredStock) {
    throw new Error(
      `Insufficient sellable stock for probe variation ${variationId}: need ${requiredStock}, have ${String(match.remain_quantity)}`,
    );
  }
  return { id: match.id, remain_quantity: match.remain_quantity };
}

export type ReadBackLine = ProbeLine & Readonly<{ variationId: string }>;

export function readBackOrderLines(orderPayload: unknown): {
  lines: readonly ReadBackLine[];
  orderTotalPriceVnd: number | null;
} {
  if (!orderPayload || typeof orderPayload !== "object") throw new Error("Invalid order read-back payload");
  const order = ((orderPayload as { data?: unknown }).data ?? orderPayload) as Record<string, unknown>;
  if (!Array.isArray(order.items)) throw new Error("Order payload missing items array");

  const lines: ReadBackLine[] = order.items.map((item: unknown) => {
    const record = (item ?? {}) as {
      variation_id?: unknown;
      quantity?: unknown;
      variation_info?: { retail_price?: unknown };
    };
    const price = record.variation_info?.retail_price;
    if (
      typeof record.variation_id !== "string" ||
      typeof record.quantity !== "number" ||
      !Number.isSafeInteger(record.quantity) ||
      typeof price !== "number" ||
      !Number.isSafeInteger(price)
    ) {
      throw new Error("Order read-back item is missing variation_id, quantity or retail_price");
    }
    return { variationId: record.variation_id, quantity: record.quantity, unitPriceVnd: price };
  });

  const total = order.total_price;
  return {
    lines,
    orderTotalPriceVnd: typeof total === "number" && Number.isSafeInteger(total) ? total : null,
  };
}

function lineKey(line: ReadBackLine): string {
  return `${line.variationId}|${line.unitPriceVnd}`;
}

/**
 * Compares read-back lines to the request as a multiset keyed by (variation, unit price) with
 * quantities summed per key. A POS that merged two prices into one, averaged them or dropped a line
 * fails here; a POS that merely re-orders lines passes. Totals are checked separately.
 */
export function compareReadBack(
  expected: readonly ReadBackLine[],
  actual: readonly ReadBackLine[],
): { preserved: boolean; detail: string } {
  const tally = (lines: readonly ReadBackLine[]) => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(lineKey(line), (map.get(lineKey(line)) ?? 0) + line.quantity);
    return map;
  };
  const want = tally(expected);
  const got = tally(actual);
  const problems: string[] = [];
  for (const [key, quantity] of want) {
    if (got.get(key) !== quantity) {
      problems.push(`expected ${quantity} x ${key.split("|")[1]} VND, found ${got.get(key) ?? 0}`);
    }
  }
  for (const key of got.keys()) {
    if (!want.has(key)) problems.push(`unexpected line at ${key.split("|")[1]} VND`);
  }
  return problems.length === 0
    ? { preserved: true, detail: "all requested price/quantity lines were preserved" }
    : { preserved: false, detail: problems.join("; ") };
}

export function buildProbeOrderInput(
  shopId: number,
  variationId: string,
  definition: ProbeCaseDefinition,
  runId: string,
): PancakeCreateOrderInput {
  return {
    shopId,
    guestName: TEST_CUSTOMER_NAME,
    guestPhone: TEST_CUSTOMER_PHONE,
    provinceRef: TEST_PROVINCE_ID,
    districtRef: TEST_DISTRICT_ID,
    communeRef: TEST_COMMUNE_ID,
    addressDetail: TEST_ADDRESS_DETAIL,
    note: `TEST AUTOMATION GQ01 ${runId} ${definition.id} - DO NOT SHIP - HUY DON`,
    shippingFeeVnd: TEST_SHIPPING_FEE_VND,
    lines: definition.lines.map((line) => ({
      pancakeVariationId: variationId,
      quantity: line.quantity,
      unitPriceVnd: line.unitPriceVnd,
    })),
  };
}

async function runCase(
  client: ControlledAcceptanceClient,
  shopId: number,
  variationId: string,
  definition: ProbeCaseDefinition,
  runId: string,
): Promise<ProbeCaseReport> {
  const expectedTotal = sumMerchandiseVnd(definition.lines);
  const base = {
    caseId: definition.id,
    gating: definition.gating,
    requestedLines: definition.lines,
    expectedMerchandiseTotalVnd: expectedTotal,
  } as const;
  const empty = {
    readBackLines: [] as const,
    readBackMerchandiseTotalVnd: null,
    orderTotalPriceVnd: null,
    totalMatchesExpected: false,
    createdPancakeOrderId: null,
    cleanupResult: "NOT_ATTEMPTED",
  } as const;
  const unknownCreation = { orderState: "CREATION_UNKNOWN" } as const;

  const request = buildPancakeCreateOrderRequest(buildProbeOrderInput(shopId, variationId, definition, runId));

  let createResponse: unknown;
  try {
    // Exactly one attempt. Pancake has no idempotency key, so a retry could create a second order.
    createResponse = await client.postJson(`/shops/${shopId}/orders`, request);
  } catch (error) {
    const rejected = error instanceof PancakeHttpError && error.status >= 400 && error.status < 500;
    return {
      ...base,
      ...empty,
      outcome: rejected ? "REJECTED_BY_POS" : "UNKNOWN_RESPONSE",
      orderState: rejected ? "NOT_CREATED" : "CREATION_UNKNOWN",
      note: rejected
        ? `POS rejected the request with HTTP ${(error as PancakeHttpError).status}; no order was created`
        : "Create call did not return a definite answer. Do NOT retry: search the POS for the run id in the order note and cancel any order found",
    };
  }

  let createdOrderId: string;
  try {
    createdOrderId = extractCreatedOrderId(createResponse);
  } catch {
    return {
      ...base,
      ...empty,
      outcome: "UNKNOWN_RESPONSE",
      ...unknownCreation,
      note: "Create response had no parsable order id. Do NOT retry: search the POS for the run id in the order note and cancel any order found",
    };
  }

  let result: Omit<ProbeCaseReport, "cleanupResult" | "orderState"> | undefined;
  try {
    const payload = await client.getJson(`/shops/${shopId}/orders/${createdOrderId}`);
    const { lines, orderTotalPriceVnd } = readBackOrderLines(payload);
    const expectedLines: ReadBackLine[] = definition.lines.map((line) => ({ variationId, ...line }));
    const comparison = compareReadBack(expectedLines, lines);
    const readBackTotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
    // P10 observed `total_price` as the merchandise total with shipping reported separately.
    const totalMatches = orderTotalPriceVnd === expectedTotal && readBackTotal === expectedTotal;
    result = {
      ...base,
      outcome: comparison.preserved && totalMatches ? "PASS" : "FAIL_LINES_NOT_PRESERVED",
      readBackLines: lines,
      readBackMerchandiseTotalVnd: readBackTotal,
      orderTotalPriceVnd,
      totalMatchesExpected: totalMatches,
      createdPancakeOrderId: createdOrderId,
      note: comparison.preserved
        ? totalMatches
          ? comparison.detail
          : "lines preserved but order total differs from the expected merchandise total"
        : comparison.detail,
    };
  } catch {
    result = undefined;
  }

  // Whatever happened after creation, the test order must not stay open. This never throws.
  const cleanupResult = await cancelAndVerify(client, shopId, createdOrderId);

  const cleanedUp = cleanupResult === CLEANUP_CONFIRMED;
  const orderState: ProbeOrderState = cleanedUp ? "CREATED_CANCELLED" : "CREATED_CLEANUP_UNCONFIRMED";
  if (result) {
    // A case that left an open test order behind has not passed, whatever the read-back showed.
    return cleanedUp
      ? { ...result, cleanupResult, orderState }
      : {
          ...result,
          outcome: "CLEANUP_NOT_CONFIRMED",
          cleanupResult,
          orderState,
          note: `${result.note}. The created order was NOT confirmed cancelled (${cleanupResult}); cancel it manually before continuing`,
        };
  }
  return {
    ...base,
    ...empty,
    outcome: "UNKNOWN_RESPONSE",
    createdPancakeOrderId: createdOrderId,
    cleanupResult,
    orderState,
    note: "Read-back failed after the order was created; cancellation was attempted. Treat the case as not proven",
  };
}

/**
 * Cancels the test order and PROVES it is cancelled. `success: true` from the PUT is not proof: the
 * API can acknowledge a request without applying it, so the order is read back and must report
 * status 7. A PUT body that itself names a different status, or a read-back that disagrees, is a
 * contradiction and fails closed. Never throws.
 */
export async function cancelAndVerify(
  client: ControlledAcceptanceClient,
  shopId: number,
  orderId: string,
): Promise<string> {
  const endpoint = `/shops/${shopId}/orders/${orderId}`;
  let put: { success?: unknown; data?: { status?: unknown }; status?: unknown } | null | undefined;
  try {
    put = (await client.putJson(endpoint, { status: 7 })) as typeof put; // 7 = CANCELED
  } catch (error) {
    return `CLEANUP_FAILED_${sanitizeCleanupErrorMessage(error instanceof Error ? error.message : String(error))}`;
  }
  const reported = put?.data?.status ?? put?.status;
  if (typeof reported === "number" && reported !== 7) return `CANCEL_RESPONSE_STATUS_${reported}`;
  if (reported === undefined && put?.success !== true) return "PUT_RETURNED_UNEXPECTED_BODY";

  try {
    const payload = (await client.getJson(endpoint)) as { data?: { status?: unknown }; status?: unknown } | null;
    const status = payload?.data?.status ?? payload?.status;
    if (status === 7) return CLEANUP_CONFIRMED;
    return `CANCEL_NOT_VERIFIED_STATUS_${typeof status === "number" ? status : "MISSING"}`;
  } catch {
    return "CANCEL_NOT_VERIFIED_READBACK_FAILED";
  }
}

function orderSafe(report: ProbeCaseReport): boolean {
  return report.orderState === "NOT_CREATED" || report.orderState === "CREATED_CANCELLED";
}

export type ProbeDependencies = Readonly<{
  client?: ControlledAcceptanceClient;
  now?: () => Date;
  newRunId?: () => string;
}>;

export async function runCapabilityProbe(
  env: ProbeEnvironment = process.env,
  dependencies: ProbeDependencies = {},
): Promise<ProbeReport> {
  const config = readPancakeConfig(env);
  assertProbeApproved(env, config.shopId);
  const selection = parseProbeSelection(env);

  const variationId = env[PROBE_VARIATION_ENV]?.trim();
  const productCode = env[PROBE_PRODUCT_CODE_ENV]?.trim();
  if (!variationId || !productCode) {
    throw new Error(`${PROBE_VARIATION_ENV} and ${PROBE_PRODUCT_CODE_ENV} are required`);
  }
  const runId = env[PROBE_RUN_ID_ENV]?.trim() || (dependencies.newRunId ?? randomUUID)().slice(0, 8);
  if (!/^[A-Za-z0-9-]{1,16}$/.test(runId)) throw new Error(`${PROBE_RUN_ID_ENV} must be 1-16 alphanumeric characters`);

  const client = dependencies.client ?? new PancakeClient({ apiKey: config.apiKey });

  const requiredStock = Math.max(
    ...selection.map((id) => PROBE_CASES[id].lines.reduce((sum, line) => sum + line.quantity, 0)),
  );
  // Preflight before any write: the variation exists and can cover the largest selected case.
  const variations = await client.getJson(`/shops/${config.shopId}/products/variations`, {
    search: productCode,
  });
  validateProbeVariation(variations, variationId, requiredStock);

  const cases: ProbeCaseReport[] = [];
  for (const id of selection) {
    const report = await runCase(client, config.shopId, variationId, PROBE_CASES[id], runId);
    cases.push(report);
    // A case that ended in an unknown state, or that left a created order open, may have left an
    // order behind: stop and let the operator reconcile before anything else is created.
    if (report.outcome === "UNKNOWN_RESPONSE" || !orderSafe(report)) break;
  }
  const noOrderMayBeOpen = cases.every(orderSafe);

  return Object.freeze({
    runId,
    timestamp: (dependencies.now ?? (() => new Date()))().toISOString(),
    shopId: config.shopId,
    variationId,
    cases: Object.freeze(cases),
    allSelectedGatingCasesPassed:
      noOrderMayBeOpen &&
      cases.length === selection.length &&
      cases.filter((entry) => entry.gating).every((entry) => entry.outcome === "PASS"),
    noOrderMayBeOpen,
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    const report = await runCapabilityProbe();
    console.log("PANCAKE_GIFT_QUANTITY_PROBE_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("PANCAKE_GIFT_QUANTITY_PROBE_END");
    // 3: a test order may still be open, or its creation is unknown (act first); 2: the capability is not proven; 0: proven.
    process.exit(!report.noOrderMayBeOpen ? 3 : report.allSelectedGatingCasesPassed ? 0 : 2);
  } catch (error) {
    console.error(`Gift/quantity POS probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
