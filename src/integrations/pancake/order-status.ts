type JsonRecord = Record<string, unknown>;

export const PANCAKE_ORDER_STATUS_CODES = [
  0, 17, 11, 12, 13, 20, 1, 8, 9, 2, 3, 16, 4, 15, 5, 6, 7,
] as const;

export type PancakeOrderStatusCode = (typeof PANCAKE_ORDER_STATUS_CODES)[number];

export type PancakeOrderStatus = Readonly<{
  orderId: string;
  systemId: number;
  shopId: number;
  status: PancakeOrderStatusCode;
  insertedAt: string;
  updatedAt: string;
}>;

export class PancakeOrderStatusContractError extends Error {
  constructor() {
    super("Pancake order-status response is invalid");
    this.name = "PancakeOrderStatusContractError";
  }
}

const STATUS_CODES = new Set<number>(PANCAKE_ORDER_STATUS_CODES);
const PANCAKE_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;

type TimestampSemantics = "INSTANT" | "WALL_CLOCK";

type ParsedDateTime = Readonly<{
  value: string;
  semantics: TimestampSemantics;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  subMillisecondNanoseconds: number;
  epochMilliseconds: number | null;
}>;

function invalidContract(): never {
  throw new PancakeOrderStatusContractError();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isCanonicalPancakeOrderId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    return false;
  }

  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

function requireExpectedShopId(value: unknown): number {
  if (!isPositiveSafeInteger(value)) invalidContract();
  return value;
}

function requireExpectedOrderId(value: unknown): string {
  if (!isCanonicalPancakeOrderId(value)) invalidContract();
  return value;
}

function requirePositiveSafeInteger(value: unknown): number {
  if (!isPositiveSafeInteger(value)) invalidContract();
  return value;
}

function requireStatusCode(value: unknown): PancakeOrderStatusCode {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || !STATUS_CODES.has(value)) {
    invalidContract();
  }
  return value as PancakeOrderStatusCode;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function parseDateTime(value: unknown): ParsedDateTime {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value) {
    invalidContract();
  }

  const match = PANCAKE_DATE_TIME.exec(value);
  if (!match) invalidContract();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zulu = match[8];
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const hasTimezone = zulu !== undefined || offsetSign !== undefined;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (hasTimezone && (offsetHour > 23 || offsetMinute > 59))
  ) {
    invalidContract();
  }

  const paddedFraction = fraction.padEnd(9, "0");
  const millisecondsText = paddedFraction.slice(0, 3);
  const millisecond = Number(millisecondsText || "0");
  const subMillisecondNanoseconds = Number(paddedFraction.slice(3, 9) || "0");
  if (!Number.isSafeInteger(millisecond) || !Number.isSafeInteger(subMillisecondNanoseconds)) {
    invalidContract();
  }

  if (!hasTimezone) {
    return {
      value,
      semantics: "WALL_CLOCK",
      year,
      month,
      day,
      hour,
      minute,
      second,
      millisecond,
      subMillisecondNanoseconds,
      epochMilliseconds: null,
    };
  }

  const timezone = zulu ?? `${offsetSign}${match[10]}:${match[11]}`;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${
    fraction.length > 0 ? `.${millisecondsText}` : ""
  }${timezone}`;
  const epochMilliseconds = Date.parse(normalized);
  if (!Number.isSafeInteger(epochMilliseconds)) invalidContract();

  return {
    value,
    semantics: "INSTANT",
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    subMillisecondNanoseconds,
    epochMilliseconds,
  };
}

function requireDateTime(value: unknown): string {
  return parseDateTime(value).value;
}

function compareNumber(left: number, right: number): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareWallClock(left: ParsedDateTime, right: ParsedDateTime): -1 | 0 | 1 {
  for (const key of [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "subMillisecondNanoseconds",
  ] as const) {
    const comparison = compareNumber(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function comparePancakeOrderStatusTimestamps(left: unknown, right: unknown): -1 | 0 | 1 {
  const leftTimestamp = parseDateTime(left);
  const rightTimestamp = parseDateTime(right);
  if (leftTimestamp.semantics !== rightTimestamp.semantics) invalidContract();

  if (leftTimestamp.semantics === "WALL_CLOCK") {
    return compareWallClock(leftTimestamp, rightTimestamp);
  }

  const leftEpoch = leftTimestamp.epochMilliseconds;
  const rightEpoch = rightTimestamp.epochMilliseconds;
  if (leftEpoch === null || rightEpoch === null) invalidContract();

  const epochComparison = compareNumber(leftEpoch, rightEpoch);
  if (epochComparison !== 0) return epochComparison;
  return compareNumber(
    leftTimestamp.subMillisecondNanoseconds,
    rightTimestamp.subMillisecondNanoseconds,
  );
}

export function parsePancakeOrderStatusResponse(
  payload: unknown,
  expected: Readonly<{ shopId: number; orderId: string }>,
): PancakeOrderStatus {
  if (!expected || typeof expected !== "object") invalidContract();
  const expectedShopId = requireExpectedShopId(expected.shopId);
  const expectedOrderId = requireExpectedOrderId(expected.orderId);

  if (!isRecord(payload)) invalidContract();

  const record = isRecord(payload.data) ? payload.data : payload;

  const orderId = requirePositiveSafeInteger(record.id);
  const systemId = requirePositiveSafeInteger(record.system_id);
  const shopId = requirePositiveSafeInteger(record.shop_id);
  const status = requireStatusCode(record.status);
  const insertedAt = requireDateTime(record.inserted_at);
  const updatedAt = requireDateTime(record.updated_at);

  if (String(orderId) !== expectedOrderId || shopId !== expectedShopId) {
    invalidContract();
  }

  return {
    orderId: expectedOrderId,
    systemId,
    shopId,
    status,
    insertedAt,
    updatedAt,
  };
}
