import {
  MAX_RECONCILIATION_PAGES,
  RECONCILIATION_PAGE_SIZE,
  SYNTHETIC_GEO,
  AmbiguousWriteError,
  CleanupFailureError,
  MutationTracker,
  assertShopAuthorized,
  isRecord,
  sanitizeSecrets,
  type ProbeApiClient,
  type ResolvedProbeTargets,
} from "./capability-probe-core.ts";
import { assertMutationAllowed, fetchVariationStock } from "./capability-probe-targets.ts";
import {
  buildPancakeCreateOrderRequest,
  parsePancakeCreateOrderResponse,
  type PancakeCreateOrderInput,
} from "./order-create.ts";
import { PancakeHttpError, PancakeNetworkError } from "./client.ts";

function isDefinitelyNoWriteHttpStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

function isUncertainWriteError(error: unknown): boolean {
  if (error instanceof PancakeNetworkError) return true;
  if (error instanceof PancakeHttpError) return !isDefinitelyNoWriteHttpStatus(error.status);
  return true;
}

export type StockMutationOutcome =
  | "APPLIED"
  | "NOOP"
  | "REJECTED"
  | "RECONCILED_APPLIED"
  | "RECONCILED_NOT_APPLIED";

export async function setVariationStockSafely(
  client: ProbeApiClient,
  tracker: MutationTracker,
  targets: ResolvedProbeTargets,
  variationId: string,
  warehouseId: string,
  desiredQuantity: number,
): Promise<Readonly<{ before: number; after: number; outcome: StockMutationOutcome }>> {
  assertMutationAllowed(targets, targets.shopId, variationId, warehouseId);
  if (!Number.isFinite(desiredQuantity)) throw new TypeError("Desired stock must be finite");

  const before = (await fetchVariationStock(client, targets, variationId)).remainQuantity;
  if (before === desiredQuantity) return { before, after: before, outcome: "NOOP" };

  tracker.record();
  try {
    await client.postJson(`/shops/${targets.shopId}/variations/${variationId}/update_quantity`, {
      variations_warehouses: [
        { warehouse_id: warehouseId, remain_quantity: desiredQuantity },
      ],
    });
  } catch (error) {
    const afterError = (await fetchVariationStock(client, targets, variationId)).remainQuantity;
    if (error instanceof PancakeHttpError && isDefinitelyNoWriteHttpStatus(error.status)) {
      if (afterError !== before) {
        throw new AmbiguousWriteError(
          `Stock mutation returned deterministic HTTP ${error.status} but stock changed from ${before} to ${afterError}`,
        );
      }
      return { before, after: afterError, outcome: "REJECTED" };
    }
    if (isUncertainWriteError(error)) {
      if (afterError === desiredQuantity) {
        return { before, after: afterError, outcome: "RECONCILED_APPLIED" };
      }
      if (afterError === before) {
        return { before, after: afterError, outcome: "RECONCILED_NOT_APPLIED" };
      }
      throw new AmbiguousWriteError(
        `Stock mutation outcome is ambiguous: expected ${before} or ${desiredQuantity}, observed ${afterError}`,
      );
    }
    throw error;
  }

  const after = (await fetchVariationStock(client, targets, variationId)).remainQuantity;
  if (after !== desiredQuantity) {
    throw new AmbiguousWriteError(
      `Stock mutation returned success but readback is ${after}; expected ${desiredQuantity}`,
    );
  }
  return { before, after, outcome: "APPLIED" };
}

export type MarkerSearchResult =
  | Readonly<{ kind: "FOUND"; orderId: string }>
  | Readonly<{ kind: "ABSENT" }>
  | Readonly<{ kind: "AMBIGUOUS"; reason: string }>;

function validatedReportedTotalPages(raw: Record<string, unknown>, page: number): number | null | "INVALID" {
  if (raw.total_pages === undefined || raw.total_pages === null) return null;
  if (!Number.isInteger(raw.total_pages) || (raw.total_pages as number) < page) return "INVALID";
  return raw.total_pages as number;
}

export async function searchOrderByMarker(
  client: ProbeApiClient,
  shopId: number,
  marker: string,
): Promise<MarkerSearchResult> {
  assertShopAuthorized(shopId);
  const matches: string[] = [];
  try {
    for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
      const raw = await client.getJson(`/shops/${shopId}/orders`, {
        page_number: page,
        page_size: RECONCILIATION_PAGE_SIZE,
      });
      if (!isRecord(raw) || !Array.isArray(raw.data)) {
        return { kind: "AMBIGUOUS", reason: "invalid order-list response" };
      }
      for (const item of raw.data) {
        if (!isRecord(item)) continue;
        const note = typeof item.note === "string" ? item.note : "";
        const address =
          isRecord(item.shipping_address) && typeof item.shipping_address.address === "string"
            ? item.shipping_address.address
            : "";
        if (!note.includes(marker) && !address.includes(marker)) continue;
        if (item.id === undefined || item.id === null) {
          return { kind: "AMBIGUOUS", reason: "matching order has no id" };
        }
        matches.push(String(item.id));
      }

      const reportedTotalPages = validatedReportedTotalPages(raw, page);
      if (reportedTotalPages === "INVALID") {
        return { kind: "AMBIGUOUS", reason: "invalid or contradictory order pagination metadata" };
      }
      if (reportedTotalPages !== null) {
        if (page >= reportedTotalPages) break;
        if (page === MAX_RECONCILIATION_PAGES) {
          return {
            kind: "AMBIGUOUS",
            reason: "bounded order search did not cover all reported pages",
          };
        }
        continue;
      }

      if (raw.data.length < RECONCILIATION_PAGE_SIZE) break;
      if (page === MAX_RECONCILIATION_PAGES) {
        return {
          kind: "AMBIGUOUS",
          reason: "bounded order search reached its limit without authoritative pagination metadata",
        };
      }
    }
  } catch (error) {
    return {
      kind: "AMBIGUOUS",
      reason: sanitizeSecrets(error instanceof Error ? error.message : String(error)),
    };
  }

  if (matches.length === 1) return { kind: "FOUND", orderId: matches[0]! };
  if (matches.length > 1) {
    return { kind: "AMBIGUOUS", reason: "multiple orders matched the unique marker" };
  }
  return { kind: "ABSENT" };
}

export type ProbeWriteCertainty = "CREATED" | "DEFINITE_NO_WRITE" | "AMBIGUOUS";
export type ProbeCapabilityEvidence = "SUPPORTED" | "UNSUPPORTED" | "NONE";

export type ProbeOrderSubmission = Readonly<{
  orderId: string | null;
  marker: string;
  rawOutcome: string;
  ambiguous: boolean;
  writeCertainty: ProbeWriteCertainty;
  capabilityEvidence: ProbeCapabilityEvidence;
}>;

export async function submitProbeOrder(
  client: ProbeApiClient,
  tracker: MutationTracker,
  targets: ResolvedProbeTargets,
  variationId: string,
  quantity: number,
  unitPriceVnd: number,
  runId: string,
  scenarioTag: string,
): Promise<ProbeOrderSubmission> {
  assertMutationAllowed(targets, targets.shopId, variationId);
  tracker.record();
  const marker = `G2-PROBE-${runId}-${scenarioTag}`;
  const input: PancakeCreateOrderInput = {
    shopId: targets.shopId,
    guestName: SYNTHETIC_GEO.name,
    guestPhone: SYNTHETIC_GEO.phone,
    provinceRef: SYNTHETIC_GEO.provinceId,
    districtRef: SYNTHETIC_GEO.districtId,
    communeRef: SYNTHETIC_GEO.communeId,
    addressDetail: `${SYNTHETIC_GEO.address} [${marker}]`,
    note: `${marker} - DO NOT SHIP - HUY DON TEST G2`,
    shippingFeeVnd: 0,
    lines: [{ pancakeVariationId: variationId, quantity, unitPriceVnd }],
  };

  try {
    const raw = await client.postJson(
      `/shops/${targets.shopId}/orders`,
      buildPancakeCreateOrderRequest(input),
    );
    try {
      return {
        orderId: parsePancakeCreateOrderResponse(raw),
        marker,
        rawOutcome: "ACCEPTED",
        ambiguous: false,
        writeCertainty: "CREATED",
        capabilityEvidence: "SUPPORTED",
      };
    } catch {
      const markerSearch = await searchOrderByMarker(client, targets.shopId, marker);
      if (markerSearch.kind === "FOUND") {
        return {
          orderId: markerSearch.orderId,
          marker,
          rawOutcome: "RECONCILED_ACCEPTED",
          ambiguous: false,
          writeCertainty: "CREATED",
          capabilityEvidence: "SUPPORTED",
        };
      }
      return {
        orderId: null,
        marker,
        rawOutcome: `AMBIGUOUS_SUCCESS_RESPONSE_${markerSearch.kind}`,
        ambiguous: true,
        writeCertainty: "AMBIGUOUS",
        capabilityEvidence: "NONE",
      };
    }
  } catch (error) {
    if (error instanceof PancakeHttpError && isDefinitelyNoWriteHttpStatus(error.status)) {
      return {
        orderId: null,
        marker,
        rawOutcome: `HTTP_NON_CAPABILITY_REJECTION_${error.status}`,
        ambiguous: false,
        writeCertainty: "DEFINITE_NO_WRITE",
        capabilityEvidence: "NONE",
      };
    }

    const markerSearch = await searchOrderByMarker(client, targets.shopId, marker);
    if (markerSearch.kind === "FOUND") {
      return {
        orderId: markerSearch.orderId,
        marker,
        rawOutcome: "RECONCILED_ACCEPTED",
        ambiguous: false,
        writeCertainty: "CREATED",
        capabilityEvidence: "SUPPORTED",
      };
    }
    return {
      orderId: null,
      marker,
      rawOutcome:
        markerSearch.kind === "AMBIGUOUS"
          ? `AMBIGUOUS_WRITE_${markerSearch.reason}`
          : "AMBIGUOUS_WRITE_NO_MARKER_FOUND",
      ambiguous: true,
      writeCertainty: "AMBIGUOUS",
      capabilityEvidence: "NONE",
    };
  }
}

async function readOrderStatus(
  client: ProbeApiClient,
  shopId: number,
  orderId: string,
): Promise<number | undefined> {
  const raw = await client.getJson(`/shops/${shopId}/orders/${orderId}`);
  const record = isRecord(raw) && isRecord(raw.data) ? raw.data : isRecord(raw) ? raw : null;
  return typeof record?.status === "number" ? record.status : undefined;
}

export async function cancelProbeOrder(
  client: ProbeApiClient,
  tracker: MutationTracker,
  shopId: number,
  orderId: string,
): Promise<void> {
  assertShopAuthorized(shopId);
  tracker.record();
  let putError: unknown;
  try {
    await client.putJson(`/shops/${shopId}/orders/${orderId}`, { status: 7 });
  } catch (error) {
    putError = error;
  }

  try {
    const status = await readOrderStatus(client, shopId, orderId);
    if (status === 7) return;
    const putContext = putError
      ? ` after ambiguous cancellation error: ${sanitizeSecrets(putError instanceof Error ? putError.message : String(putError))}`
      : "";
    throw new CleanupFailureError(
      `Order ${orderId} cancellation readback expected status 7, observed ${String(status ?? "UNKNOWN")}${putContext}`,
    );
  } catch (error) {
    if (error instanceof CleanupFailureError) throw error;
    const putContext = putError
      ? `; cancellation error was ${sanitizeSecrets(putError instanceof Error ? putError.message : String(putError))}`
      : "";
    throw new CleanupFailureError(
      `Order ${orderId} cancellation readback failed: ${sanitizeSecrets(error instanceof Error ? error.message : String(error))}${putContext}`,
    );
  }
}
