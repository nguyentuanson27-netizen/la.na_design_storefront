export const AUTHORIZED_SHOP_ID = 1720000650;
export const MAX_MUTATION_BUDGET = 30;
export const MAX_CONCURRENCY = 2;
export const RECONCILIATION_PAGE_SIZE = 50;
export const MAX_RECONCILIATION_PAGES = 3;

export const AUTHORIZED_CODES = {
  ORDINARY: "V8014",
  COMPOSITE_PARENT: "SV1683-S",
  COMPOSITE_CHILD_AO: "SV1683-AO-S",
  COMPOSITE_CHILD_VAY: "SV1683-VAY-S",
} as const;

export const SYNTHETIC_GEO = {
  provinceId: "805",
  districtId: "80505",
  communeId: "8050501",
  address: "G2 PROBE TEST HARNESS - KHONG GIAO HANG",
  name: "G2-PROBE-SYNTHETIC",
  phone: "0900000000",
} as const;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class CapabilityProbeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityProbeGuardError";
  }
}

export class MutationBudgetExceededError extends Error {
  constructor(current: number, requested: number) {
    super(
      `Mutation budget exceeded: ${current} already used; ${requested} additional mutation(s) would exceed ${MAX_MUTATION_BUDGET}`,
    );
    this.name = "MutationBudgetExceededError";
  }
}

export class AmbiguousWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousWriteError";
  }
}

export class CleanupFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupFailureError";
  }
}

export function sanitizeSecrets(message: string): string {
  return message
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret[_-]?key|secret|password)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|token|secret[_-]?key|secret|password)["']?\s*[:=]\s*['"]?)[^\s&"',>]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[a-zA-Z0-9_.-]{6,}/gi, "$1[REDACTED]")
    .replace(/\b[0-9a-fA-F]{32,64}\b/g, "[REDACTED_KEY]")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertShopAuthorized(shopId: number): void {
  if (!Number.isSafeInteger(shopId) || shopId !== AUTHORIZED_SHOP_ID) {
    throw new CapabilityProbeGuardError(
      `Shop ${shopId} is not authorized for the G2 capability probe`,
    );
  }
}

export function assertConcurrencyAllowed(concurrency: number): void {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new CapabilityProbeGuardError(
      `Concurrency ${concurrency} is outside the authorized range 1..${MAX_CONCURRENCY}`,
    );
  }
}

export class MutationTracker {
  private count = 0;

  get mutationCount(): number {
    return this.count;
  }

  get remaining(): number {
    return MAX_MUTATION_BUDGET - this.count;
  }

  record(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new TypeError("Mutation amount must be a positive safe integer");
    }
    if (this.count + amount > MAX_MUTATION_BUDGET) {
      throw new MutationBudgetExceededError(this.count, amount);
    }
    this.count += amount;
  }
}

export type ProbeApiClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<unknown>;
  postJson(endpoint: string, body: unknown): Promise<unknown>;
  putJson(endpoint: string, body: unknown): Promise<unknown>;
};

export type ResolvedTargetVariant = Readonly<{
  variationId: string;
  displayId: string;
  productId: string;
  warehouseId: string;
  initialStock: number;
  multiplier?: number;
}>;

export type ResolvedProbeTargets = Readonly<{
  shopId: number;
  ordinary: ResolvedTargetVariant;
  compositeParent: ResolvedTargetVariant;
  compositeChildAo: ResolvedTargetVariant;
  compositeChildVay: ResolvedTargetVariant;
  allowedVariationIds: ReadonlySet<string>;
  allowedWarehouseIds: ReadonlySet<string>;
}>;

export type ProbeClassification = "SUPPORTED" | "UNSUPPORTED" | "AMBIGUOUS" | "NOT PROBED";

export type ProbeScenarioResult = Readonly<{
  scenario: string;
  target: string;
  initialStock: number;
  submissions: number;
  apiOutcome: string;
  remoteOrderCreated: "yes" | "no" | "ambiguous";
  finalStock: number;
  stockDelta: number;
  componentDeltas?: Readonly<Record<string, number>>;
  classification: ProbeClassification;
  cleanup: "restored" | "deferred" | "failed" | "not-needed";
  notes: string;
}>;

export type VariationStockInfo = Readonly<{
  variationId: string;
  displayId: string;
  remainQuantity: number;
  warehouseQuantities: Readonly<Record<string, number>>;
}>;
