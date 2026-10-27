import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { VendorLine } from "../src/commerce/pancake-gift-projection.ts";
import { compareOrderReadBack } from "../src/commerce/pancake-order-readback-check.ts";
import { canProjectExactMoney } from "../src/commerce/pancake-voucher-projection.ts";
import { allocateMerchandiseDiscount, type VoucherPaidLine } from "../src/commerce/voucher-allocation.ts";
import { applyAllocationToLines } from "../src/commerce/voucher-quote.ts";
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
 * Voucher v1 (H1-V / V09): do the exact-money vendor lines a voucher produces survive the live POS?
 *
 * For each acceptance fixture of `docs/integrations/pancake-voucher-acceptance.md` the website quote is built
 * by the PRODUCTION allocation (V02) and vendor projection (V09, ADR 0016 D-08), compared with the fixture
 * literal BEFORE anything is sent, then run through the production create / read-back / cancel adapter:
 *
 *   fixture -> allocateMerchandiseDiscount -> canProjectExactMoney == pinned literal
 *     -> buildPancakeCreateOrderRequest -> gateway.createOrder -> gateway.readOrder -> compareOrderReadBack MATCH
 *     -> gateway.cancelOrder (status 7) -> readOrder: "canceled"
 *
 * The same safety model as `pancake-gift-quantity-adapter-acceptance.ts`: refuses CI; needs
 * `GQ_POS_PROBE_APPROVED=shop:<id>`; one create per case and never a retry (no idempotency key); the order is
 * cancelled on every path after creation; an unproven cancellation is never a pass and stops the run; no key
 * and no customer data in the report. All fixture variations (V1, V2, G1) are mapped to the one probe variation,
 * which is enough because the vendor keeps lines of one variation apart by price (gift-quantity evidence).
 */

export const VOUCHER_CASE_IDS = ["F1_SPLIT_ONE_LINE", "F2_SAME_VARIATION_TWO_LINES", "F3_VOUCHER_THEN_GIFT_OFFSET", "F4_TINY_PRICES"] as const;
export type VoucherCaseId = (typeof VOUCHER_CASE_IDS)[number];

type VoucherCaseDefinition = Readonly<{
  id: VoucherCaseId;
  purpose: string;
  /** Website lines before the voucher: [lineId, quantity, unitPriceVnd]. */
  lines: readonly (readonly [string, number, number])[];
  discountVnd: number;
  giftUnits: number;
  /** The pinned fixture: what the vendor must be sent and what the order total must read back as. */
  expectedVendorLines: readonly Readonly<{ quantity: number; unitPriceVnd: number }>[];
  expectedTotalVnd: number;
  units: number;
}>;

export const VOUCHER_CASES: Readonly<Record<VoucherCaseId, VoucherCaseDefinition>> = Object.freeze({
  F1_SPLIT_ONE_LINE: {
    id: "F1_SPLIT_ONE_LINE",
    purpose: "3 x 100.000 with a 10.000 voucher is 2 x 96.667 + 1 x 96.666, total 290.000",
    lines: [["a", 3, 100_000]],
    discountVnd: 10_000,
    giftUnits: 0,
    expectedVendorLines: [{ quantity: 2, unitPriceVnd: 96_667 }, { quantity: 1, unitPriceVnd: 96_666 }],
    expectedTotalVnd: 290_000,
    units: 3,
  },
  F2_SAME_VARIATION_TWO_LINES: {
    id: "F2_SAME_VARIATION_TWO_LINES",
    purpose: "one variation on two website lines stays two vendor lines (275.000 and 2 x 137.500), total 550.000",
    lines: [["a", 1, 300_000], ["b", 2, 150_000]],
    discountVnd: 50_000,
    giftUnits: 0,
    expectedVendorLines: [{ quantity: 1, unitPriceVnd: 275_000 }, { quantity: 2, unitPriceVnd: 137_500 }],
    expectedTotalVnd: 550_000,
    units: 3,
  },
  F3_VOUCHER_THEN_GIFT_OFFSET: {
    id: "F3_VOUCHER_THEN_GIFT_OFFSET",
    purpose: "voucher first, then the 1.000 gift carved out of paid units; the vendor total still equals the website total 570.000",
    lines: [["a", 2, 250_000], ["b", 1, 150_000]],
    discountVnd: 80_000,
    giftUnits: 1,
    expectedVendorLines: [
      { quantity: 1, unitPriceVnd: 219_231 },
      { quantity: 1, unitPriceVnd: 218_231 },
      { quantity: 1, unitPriceVnd: 131_538 },
      { quantity: 1, unitPriceVnd: 1_000 },
    ],
    expectedTotalVnd: 570_000,
    units: 4,
  },
  F4_TINY_PRICES: {
    id: "F4_TINY_PRICES",
    purpose: "2 x 2đ + 1 x 1.000đ with a 1.000 voucher is 1 x 2đ + 2 x 1đ, total 4 (the 1đ floor is accepted by the POS)",
    lines: [["a", 2, 2], ["b", 1, 1_000]],
    discountVnd: 1_000,
    giftUnits: 0,
    expectedVendorLines: [{ quantity: 1, unitPriceVnd: 2 }, { quantity: 2, unitPriceVnd: 1 }],
    expectedTotalVnd: 4,
    units: 3,
  },
});

export type VoucherOutcome =
  | "PASS"
  /** The production code no longer produces the pinned fixture; nothing was sent. */
  | "FAIL_FIXTURE_DRIFT"
  | "FAIL_READBACK_NOT_MATCH"
  | "FAIL_CANCEL_NOT_OBSERVED"
  | "REJECTED_BY_POS"
  | "UNKNOWN_RESPONSE"
  | "CLEANUP_NOT_CONFIRMED";

export type VoucherOrderState = "NOT_CREATED" | "CREATED_CANCELLED" | "CREATED_CLEANUP_UNCONFIRMED" | "CREATION_UNKNOWN";

export type VoucherCaseReport = Readonly<{
  caseId: VoucherCaseId;
  outcome: VoucherOutcome;
  orderState: VoucherOrderState;
  sentLines: readonly VendorLine[];
  expectedTotalVnd: number;
  readBackWhileOpen: Readonly<{ lines: readonly VendorLine[]; totalPriceVnd: number | null; reportedOrderId: string | null; reportedShopId: number | null; status: number | null }> | null;
  verdictWhileOpen: string;
  verdictAfterCancel: string;
  statusWhileOpen: number | null;
  statusAfterCancel: number | null;
  createdPancakeOrderId: string | null;
  cleanupResult: string;
  note: string;
}>;

export type VoucherReport = Readonly<{
  runId: string;
  timestamp: string;
  shopId: number;
  variationId: string;
  cases: readonly VoucherCaseReport[];
  allCasesPassed: boolean;
  noOrderMayBeOpen: boolean;
}>;

type VoucherGateway = Readonly<{
  createOrder: (request: ReturnType<typeof buildPancakeCreateOrderRequest>) => Promise<unknown>;
  readOrder: (shopId: number, orderId: string) => Promise<PancakeOrderReadBack>;
  cancelOrder: (shopId: number, orderId: string) => Promise<void>;
}>;

export type VoucherDependencies = Readonly<{
  client?: ControlledAcceptanceClient;
  gateway?: VoucherGateway;
  now?: () => Date;
  newRunId?: () => string;
}>;

const describeVerdict = (verdict: ReturnType<typeof compareOrderReadBack>): string =>
  verdict.kind === "MATCH" ? "MATCH" : `${verdict.kind}: ${verdict.detail}`;

const orderSafe = (report: VoucherCaseReport): boolean => report.orderState === "NOT_CREATED" || report.orderState === "CREATED_CANCELLED";

/** The vendor lines the production code derives for a fixture, or null when it cannot represent it. */
export function deriveVendorLines(definition: VoucherCaseDefinition, variationId: string): readonly VendorLine[] | null {
  const lines: readonly (VoucherPaidLine & Readonly<{ pancakeVariationId: string }>)[] = definition.lines.map(([lineId, quantity, unitPriceVnd]) => ({
    lineId,
    pancakeVariationId: variationId,
    product: { productId: lineId, shopId: "probe-shop", categoryKeys: [] },
    quantity,
    unitPriceVnd,
  }));
  const allocated = allocateMerchandiseDiscount({ lines, resolver: () => true, discountVnd: definition.discountVnd });
  if (!allocated.ok) return null;
  const paidLines = applyAllocationToLines(lines, allocated.allocation).map((l) => ({
    lineId: l.lineId,
    pancakeVariationId: variationId,
    quantity: l.quantity,
    unitPriceVnd: l.unitPriceVnd,
  }));
  const paid = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0) - definition.discountVnd;
  const gifts = definition.giftUnits > 0 ? [{ pancakeVariationId: variationId, quantity: definition.giftUnits }] : [];
  const projection = canProjectExactMoney({ paidLines, gifts, expectedPaidSubtotalVnd: paid, shippingFeeVnd: TEST_SHIPPING_FEE_VND, expectedTotalVnd: paid + TEST_SHIPPING_FEE_VND });
  return projection.ok ? projection.lines : null;
}

const sameLines = (actual: readonly VendorLine[], expected: VoucherCaseDefinition["expectedVendorLines"], variationId: string): boolean =>
  actual.length === expected.length &&
  actual.every((line, index) => line.pancakeVariationId === variationId && line.quantity === expected[index].quantity && line.unitPriceVnd === expected[index].unitPriceVnd);

async function runCase(gateway: VoucherGateway, shopId: number, variationId: string, definition: VoucherCaseDefinition, runId: string): Promise<VoucherCaseReport> {
  const empty = {
    caseId: definition.id,
    expectedTotalVnd: definition.expectedTotalVnd,
    sentLines: [] as readonly VendorLine[],
    readBackWhileOpen: null,
    verdictWhileOpen: "NOT_READ",
    verdictAfterCancel: "NOT_READ",
    statusWhileOpen: null,
    statusAfterCancel: null,
    createdPancakeOrderId: null,
    cleanupResult: "NOT_ATTEMPTED",
  } as const;

  const derived = deriveVendorLines(definition, variationId);
  if (derived === null || !sameLines(derived, definition.expectedVendorLines, variationId)) {
    return { ...empty, outcome: "FAIL_FIXTURE_DRIFT", orderState: "NOT_CREATED", note: "the production code no longer yields the pinned fixture lines; nothing was sent" };
  }

  const request = buildPancakeCreateOrderRequest({
    shopId,
    guestName: TEST_CUSTOMER_NAME,
    guestPhone: TEST_CUSTOMER_PHONE,
    provinceRef: TEST_PROVINCE_ID,
    districtRef: TEST_DISTRICT_ID,
    communeRef: TEST_COMMUNE_ID,
    addressDetail: TEST_ADDRESS_DETAIL,
    note: `TEST AUTOMATION VOUCHER ${runId} ${definition.id} - DO NOT SHIP - HUY DON`,
    shippingFeeVnd: TEST_SHIPPING_FEE_VND,
    lines: derived,
  });
  const sent = { ...empty, sentLines: derived };

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
    return { ...sent, outcome: "UNKNOWN_RESPONSE", orderState: "CREATION_UNKNOWN", note: "Create response had no parsable order id. Do NOT retry: search the POS for the run id in the order note and cancel any order found" };
  }

  let readBackWhileOpen: VoucherCaseReport["readBackWhileOpen"] = null;
  let verdictWhileOpen = "READBACK_FAILED";
  let totalMatches = false;
  try {
    const readBack = await gateway.readOrder(shopId, orderId);
    readBackWhileOpen = { lines: readBack.lines, totalPriceVnd: readBack.totalPriceVnd, reportedOrderId: readBack.orderId, reportedShopId: readBack.shopId, status: readBack.status };
    totalMatches = readBack.totalPriceVnd === definition.expectedTotalVnd;
    verdictWhileOpen = describeVerdict(compareOrderReadBack(derived, readBack, { orderId, shopId }));
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
  const orderState: VoucherOrderState = cleanedUp ? "CREATED_CANCELLED" : "CREATED_CLEANUP_UNCONFIRMED";

  let verdictAfterCancel = "NOT_READ";
  let statusAfterCancel: number | null = null;
  if (cleanedUp) {
    try {
      const after = await gateway.readOrder(shopId, orderId);
      statusAfterCancel = after.status;
      verdictAfterCancel = describeVerdict(compareOrderReadBack(derived, after, { orderId, shopId }));
    } catch (error) {
      verdictAfterCancel = `READBACK_FAILED: ${sanitizeCleanupErrorMessage(error instanceof Error ? error.message : String(error))}`;
    }
  }

  const base = {
    ...sent,
    readBackWhileOpen,
    verdictWhileOpen,
    verdictAfterCancel,
    statusWhileOpen: readBackWhileOpen?.status ?? null,
    statusAfterCancel,
    createdPancakeOrderId: orderId,
    cleanupResult,
    orderState,
  };
  if (!cleanedUp) return { ...base, outcome: "CLEANUP_NOT_CONFIRMED", note: `The created order was NOT confirmed cancelled (${cleanupResult}); cancel it manually before continuing` };
  if (verdictWhileOpen !== "MATCH" || !totalMatches) {
    return { ...base, outcome: "FAIL_READBACK_NOT_MATCH", note: `the read-back did not confirm the lines and the ${definition.expectedTotalVnd}đ total while the order was open (${verdictWhileOpen})` };
  }
  if (verdictAfterCancel !== "DRIFT: the POS order is canceled") {
    return { ...base, outcome: "FAIL_CANCEL_NOT_OBSERVED", note: `the canceled order did not read back as canceled (${verdictAfterCancel})` };
  }
  return { ...base, outcome: "PASS", note: definition.purpose };
}

export async function runVoucherAcceptance(env: Readonly<Record<string, string | undefined>> = process.env, dependencies: VoucherDependencies = {}): Promise<VoucherReport> {
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
  const requiredStock = Math.max(...VOUCHER_CASE_IDS.map((id) => VOUCHER_CASES[id].units));
  validateProbeVariation(await client.getJson(`/shops/${config.shopId}/products/variations`, { search: productCode }), variationId, requiredStock);

  const cases: VoucherCaseReport[] = [];
  for (const id of VOUCHER_CASE_IDS) {
    const report = await runCase(gateway, config.shopId, variationId, VOUCHER_CASES[id], runId);
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
    allCasesPassed: noOrderMayBeOpen && cases.length === VOUCHER_CASE_IDS.length && cases.every((entry) => entry.outcome === "PASS"),
    noOrderMayBeOpen,
  });
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    const report = await runVoucherAcceptance();
    console.log("PANCAKE_VOUCHER_ACCEPTANCE_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("PANCAKE_VOUCHER_ACCEPTANCE_END");
    // 3: a test order may still be open, or its creation is unknown (act first); 2: not proven; 0: proven.
    process.exit(!report.noOrderMayBeOpen ? 3 : report.allCasesPassed ? 0 : 2);
  } catch (error) {
    console.error(`Voucher acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
