import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { projectBenefitQuoteForVendor, type ProjectionLine, type VendorLine } from "../src/commerce/pancake-gift-projection.ts";
import { compareOrderReadBack } from "../src/commerce/pancake-order-readback-check.ts";
import { PancakeClient, PancakeHttpError } from "../src/integrations/pancake/client.ts";
import { readPancakeConfig } from "../src/integrations/pancake/config.ts";
import { buildPancakeCreateOrderRequest, parsePancakeCreateOrderResponse } from "../src/integrations/pancake/order-create.ts";
import { createPancakeOrderGateway } from "../src/integrations/pancake/order-gateway.ts";
import type { PancakeOrderReadBack } from "../src/integrations/pancake/order-readback.ts";
import { assertProbeApproved, PROBE_PRODUCT_CODE_ENV, PROBE_VARIATION_ENV, validateProbeVariation } from "./pancake-gift-quantity-capability-probe.ts";
import {
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
 * Gift & Quantity Promotions v1 (GQ21 / acceptance O-2): the PRODUCTION adapter flow against the live POS.
 *
 * `pancake-gift-quantity-capability-probe.ts` already proved the vendor keeps several lines of one variation
 * apart. It uses its own parser, so the parser the checkout actually relies on has only ever seen fakes.
 * This script runs the code a benefit order really uses, end to end, on a controlled test order:
 *
 *   quote facts -> D-08 projection -> buildPancakeCreateOrderRequest -> gateway.createOrder
 *     -> parsePancakeCreateOrderResponse -> gateway.readOrder (parsePancakeOrderReadBack, identity checked)
 *     -> compareOrderReadBack(expected projection, read-back, { orderId, shopId })  must be MATCH
 *     -> gateway.cancelOrder (PUT status 7, read back)  -> readOrder again: DRIFT "canceled"
 *
 * The last step proves the status field the parser reads is the one the POS really writes, which is the
 * evidence the repository does not otherwise have for `status`/`id`/`shop_id` on this endpoint.
 *
 * Safety model, the same as the probe's: refuses CI; needs `GQ_POS_PROBE_APPROVED=shop:<id>`; one create
 * attempt per case and never a retry (no idempotency key); the order created is cancelled on every path
 * after creation and a case whose cancellation is not proven is never a pass and stops the run.
 * Nothing here runs from the test suite against the network; tests inject a fake gateway.
 */

export const ADAPTER_CASE_IDS = ["ADAPTER_TIER_SPLIT_PAID", "ADAPTER_PAID_PLUS_GIFT_SAME_VARIATION"] as const;
export type AdapterCaseId = (typeof ADAPTER_CASE_IDS)[number];

type AdapterCaseDefinition = Readonly<{
  id: AdapterCaseId;
  purpose: string;
  /** The website quote lines, as the checkout signs them (gifts at 0đ). */
  quoteLines: (variationId: string) => readonly ProjectionLine[];
  units: number;
}>;

export const ADAPTER_CASES: Readonly<Record<AdapterCaseId, AdapterCaseDefinition>> = Object.freeze({
  ADAPTER_TIER_SPLIT_PAID: {
    id: "ADAPTER_TIER_SPLIT_PAID",
    purpose: "EX-17 through the adapter: 2 x 100.001đ + 1 x 90.001đ of one variation are stored apart and read back as MATCH",
    quoteLines: (variationId) => [
      { lineId: `P:${variationId}:0`, role: "PAID", pancakeVariationId: variationId, quantity: 2, unitPriceVnd: 100_001 },
      { lineId: `P:${variationId}:1`, role: "PAID", pancakeVariationId: variationId, quantity: 1, unitPriceVnd: 90_001 },
    ],
    units: 3,
  },
  ADAPTER_PAID_PLUS_GIFT_SAME_VARIATION: {
    id: "ADAPTER_PAID_PLUS_GIFT_SAME_VARIATION",
    purpose: "D-08 through the adapter: a paid unit and a gift unit of one variation become 99.000đ + 1.000đ and read back as MATCH",
    quoteLines: (variationId) => [
      { lineId: `P:${variationId}:0`, role: "PAID", pancakeVariationId: variationId, quantity: 1, unitPriceVnd: 100_000 },
      { lineId: `G:${variationId}:0`, role: "GIFT", pancakeVariationId: variationId, quantity: 1, unitPriceVnd: 0 },
    ],
    units: 2,
  },
});

export type AdapterOutcome =
  | "PASS"
  /** The POS stored something other than what was sent, or the read-back could not confirm it. */
  | "FAIL_READBACK_NOT_MATCH"
  /** Matched while open, but the canceled order did not read back as canceled. */
  | "FAIL_CANCEL_NOT_OBSERVED"
  | "REJECTED_BY_POS"
  | "UNKNOWN_RESPONSE"
  | "CLEANUP_NOT_CONFIRMED";

export type AdapterOrderState = "NOT_CREATED" | "CREATED_CANCELLED" | "CREATED_CLEANUP_UNCONFIRMED" | "CREATION_UNKNOWN";

export type AdapterCaseReport = Readonly<{
  caseId: AdapterCaseId;
  outcome: AdapterOutcome;
  orderState: AdapterOrderState;
  sentLines: readonly VendorLine[];
  /** What the production parser extracted while the order was open (no customer data, no key). */
  readBackWhileOpen: Readonly<{ lines: readonly VendorLine[]; totalPriceVnd: number | null; reportedOrderId: string | null; reportedShopId: number | null; status: number | null }> | null;
  verdictWhileOpen: string;
  verdictAfterCancel: string;
  createdPancakeOrderId: string | null;
  cleanupResult: string;
  note: string;
}>;

export type AdapterReport = Readonly<{
  runId: string;
  timestamp: string;
  shopId: number;
  variationId: string;
  cases: readonly AdapterCaseReport[];
  allCasesPassed: boolean;
  noOrderMayBeOpen: boolean;
}>;

type AdapterGateway = Readonly<{
  createOrder: (request: ReturnType<typeof buildPancakeCreateOrderRequest>) => Promise<unknown>;
  readOrder: (shopId: number, orderId: string) => Promise<PancakeOrderReadBack>;
  cancelOrder: (shopId: number, orderId: string) => Promise<void>;
}>;

export type AdapterDependencies = Readonly<{
  /** Used for the read-only stock preflight only. */
  client?: ControlledAcceptanceClient;
  gateway?: AdapterGateway;
  now?: () => Date;
  newRunId?: () => string;
}>;

const describeVerdict = (verdict: ReturnType<typeof compareOrderReadBack>): string =>
  verdict.kind === "MATCH" ? "MATCH" : `${verdict.kind}: ${verdict.detail}`;

function orderSafe(report: AdapterCaseReport): boolean {
  return report.orderState === "NOT_CREATED" || report.orderState === "CREATED_CANCELLED";
}

async function runCase(
  gateway: AdapterGateway,
  shopId: number,
  variationId: string,
  definition: AdapterCaseDefinition,
  runId: string,
): Promise<AdapterCaseReport> {
  const projection = projectBenefitQuoteForVendor(definition.quoteLines(variationId));
  const empty = {
    caseId: definition.id,
    sentLines: [] as readonly VendorLine[],
    readBackWhileOpen: null,
    verdictWhileOpen: "NOT_READ",
    verdictAfterCancel: "NOT_READ",
    createdPancakeOrderId: null,
    cleanupResult: "NOT_ATTEMPTED",
  } as const;
  if (!projection.ok) {
    return { ...empty, outcome: "REJECTED_BY_POS", orderState: "NOT_CREATED", note: `the projection itself is ${projection.reason}; nothing was sent` };
  }

  const request = buildPancakeCreateOrderRequest({
    shopId,
    guestName: TEST_CUSTOMER_NAME,
    guestPhone: TEST_CUSTOMER_PHONE,
    provinceRef: TEST_PROVINCE_ID,
    districtRef: TEST_DISTRICT_ID,
    communeRef: TEST_COMMUNE_ID,
    addressDetail: TEST_ADDRESS_DETAIL,
    note: `TEST AUTOMATION GQ ADAPTER ${runId} ${definition.id} - DO NOT SHIP - HUY DON`,
    shippingFeeVnd: TEST_SHIPPING_FEE_VND,
    lines: projection.lines,
  });
  const sent = { ...empty, sentLines: projection.lines };

  let createResponse: unknown;
  try {
    // Exactly one attempt. Pancake has no idempotency key, so a retry could create a second order.
    createResponse = await gateway.createOrder(request);
  } catch (error) {
    const rejected = error instanceof PancakeHttpError && error.status >= 400 && error.status < 500;
    return {
      ...sent,
      outcome: rejected ? "REJECTED_BY_POS" : "UNKNOWN_RESPONSE",
      orderState: rejected ? "NOT_CREATED" : "CREATION_UNKNOWN",
      note: rejected
        ? `POS rejected the request with HTTP ${(error as PancakeHttpError).status}; no order was created`
        : "Create call did not return a definite answer. Do NOT retry: search the POS for the run id in the order note and cancel any order found",
    };
  }

  let orderId: string;
  try {
    orderId = parsePancakeCreateOrderResponse(createResponse);
  } catch {
    return {
      ...sent,
      outcome: "UNKNOWN_RESPONSE",
      orderState: "CREATION_UNKNOWN",
      note: "Create response had no parsable order id. Do NOT retry: search the POS for the run id in the order note and cancel any order found",
    };
  }

  // While the order is open: the production read-back, and the production comparison.
  let readBackWhileOpen: AdapterCaseReport["readBackWhileOpen"] = null;
  let verdictWhileOpen = "READBACK_FAILED";
  try {
    const readBack = await gateway.readOrder(shopId, orderId);
    readBackWhileOpen = {
      lines: readBack.lines,
      totalPriceVnd: readBack.totalPriceVnd,
      reportedOrderId: readBack.orderId,
      reportedShopId: readBack.shopId,
      status: readBack.status,
    };
    verdictWhileOpen = describeVerdict(compareOrderReadBack(projection.lines, readBack, { orderId, shopId }));
  } catch (error) {
    verdictWhileOpen = `READBACK_FAILED: ${sanitizeCleanupErrorMessage(error instanceof Error ? error.message : String(error))}`;
  }

  // Whatever happened, the test order must not stay open. This never throws.
  let cleanupResult = "CANCEL_NOT_ATTEMPTED";
  try {
    await gateway.cancelOrder(shopId, orderId);
    cleanupResult = "CANCELED_STATUS_7";
  } catch (error) {
    cleanupResult = `CLEANUP_FAILED_${sanitizeCleanupErrorMessage(error instanceof Error ? error.message : String(error))}`;
  }
  const cleanedUp = cleanupResult === "CANCELED_STATUS_7";
  const orderState: AdapterOrderState = cleanedUp ? "CREATED_CANCELLED" : "CREATED_CLEANUP_UNCONFIRMED";

  // After cancelling, the production comparison must call the order canceled: this is what shows that
  // the `status` the parser reads is the field the POS really sets.
  let verdictAfterCancel = "NOT_READ";
  if (cleanedUp) {
    try {
      verdictAfterCancel = describeVerdict(compareOrderReadBack(projection.lines, await gateway.readOrder(shopId, orderId), { orderId, shopId }));
    } catch (error) {
      verdictAfterCancel = `READBACK_FAILED: ${sanitizeCleanupErrorMessage(error instanceof Error ? error.message : String(error))}`;
    }
  }

  const base = { ...sent, readBackWhileOpen, verdictWhileOpen, verdictAfterCancel, createdPancakeOrderId: orderId, cleanupResult, orderState };
  if (!cleanedUp) {
    return { ...base, outcome: "CLEANUP_NOT_CONFIRMED", note: `The created order was NOT confirmed cancelled (${cleanupResult}); cancel it manually before continuing` };
  }
  if (verdictWhileOpen !== "MATCH") {
    return { ...base, outcome: "FAIL_READBACK_NOT_MATCH", note: `the production read-back did not confirm the order while it was open (${verdictWhileOpen})` };
  }
  if (verdictAfterCancel !== "DRIFT: the POS order is canceled") {
    return { ...base, outcome: "FAIL_CANCEL_NOT_OBSERVED", note: `the canceled order did not read back as canceled (${verdictAfterCancel})` };
  }
  return { ...base, outcome: "PASS", note: definition.purpose };
}

export async function runAdapterAcceptance(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: AdapterDependencies = {},
): Promise<AdapterReport> {
  const config = readPancakeConfig(env);
  assertProbeApproved(env, config.shopId);

  const variationId = env[PROBE_VARIATION_ENV]?.trim();
  const productCode = env[PROBE_PRODUCT_CODE_ENV]?.trim();
  if (!variationId || !productCode) throw new Error(`${PROBE_VARIATION_ENV} and ${PROBE_PRODUCT_CODE_ENV} are required`);
  const runId = env.GQ_POS_PROBE_RUN_ID?.trim() || (dependencies.newRunId ?? randomUUID)().slice(0, 8);
  if (!/^[A-Za-z0-9-]{1,16}$/.test(runId)) throw new Error("GQ_POS_PROBE_RUN_ID must be 1-16 alphanumeric characters");

  const client = dependencies.client ?? new PancakeClient({ apiKey: config.apiKey });
  const gateway = dependencies.gateway ?? createPancakeOrderGateway(client as PancakeClient);

  // Preflight before any write: the variation exists and can cover the largest case.
  const requiredStock = Math.max(...ADAPTER_CASE_IDS.map((id) => ADAPTER_CASES[id].units));
  validateProbeVariation(await client.getJson(`/shops/${config.shopId}/products/variations`, { search: productCode }), variationId, requiredStock);

  const cases: AdapterCaseReport[] = [];
  for (const id of ADAPTER_CASE_IDS) {
    const report = await runCase(gateway, config.shopId, variationId, ADAPTER_CASES[id], runId);
    cases.push(report);
    // An unknown creation or an order left open: stop and let the operator reconcile first.
    if (report.outcome === "UNKNOWN_RESPONSE" || !orderSafe(report)) break;
  }
  const noOrderMayBeOpen = cases.every(orderSafe);
  return Object.freeze({
    runId,
    timestamp: (dependencies.now ?? (() => new Date()))().toISOString(),
    shopId: config.shopId,
    variationId,
    cases: Object.freeze(cases),
    allCasesPassed: noOrderMayBeOpen && cases.length === ADAPTER_CASE_IDS.length && cases.every((entry) => entry.outcome === "PASS"),
    noOrderMayBeOpen,
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    const report = await runAdapterAcceptance();
    console.log("PANCAKE_GIFT_QUANTITY_ADAPTER_ACCEPTANCE_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("PANCAKE_GIFT_QUANTITY_ADAPTER_ACCEPTANCE_END");
    // 3: a test order may still be open, or its creation is unknown (act first); 2: not proven; 0: proven.
    process.exit(!report.noOrderMayBeOpen ? 3 : report.allCasesPassed ? 0 : 2);
  } catch (error) {
    console.error(`Gift/quantity adapter acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
