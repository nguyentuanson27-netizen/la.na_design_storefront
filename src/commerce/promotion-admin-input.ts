/**
 * Server Action input parsing and boundary validation for promotion admin mutations.
 *
 * Boundary principles:
 * - Trimming preserves string boundaries without truncating identifiers.
 * - Oversized identifiers are preserved so domain validator can reject with IDENTIFIER_TOO_LONG.
 * - Money inputs must be strict positive decimal representations, never sanitized into altered amounts.
 * - Enums (kind, discountType) must match an exact allowlist without fail-open coercion.
 * - Dates must be strict Vietnam time (UTC+07:00) with calendar correctness validation.
 */

import {
  MAX_TARGETS_PER_CAMPAIGN,
  type CampaignTargetInput,
} from "./promotion-activation.ts";
import { isPromotionCampaignKind, type PromotionCampaignKind } from "./promotion-pricing.ts";

export type CampaignMutationValues = Readonly<{
  name: string;
  kind: PromotionCampaignKind;
  discountType: "PERCENTAGE" | "FIXED_PRICE";
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
  targets: readonly CampaignTargetInput[];
}>;

export type CampaignMutationParseReason =
  | "INVALID_CAMPAIGN_KIND"
  | "INVALID_DISCOUNT_TYPE"
  | "MALFORMED_FIXED_PRICE"
  | "INVALID_PERCENTAGE"
  | "INVALID_DATE_TIME";

export type ParsedCampaignMutation =
  | Readonly<{
      ok: true;
      value: CampaignMutationValues;
    }>
  | Readonly<{
      ok: false;
      reason: CampaignMutationParseReason;
    }>;

export function parseTargets(formData: FormData): CampaignTargetInput[] {
  const targetProductIds = formData
    .getAll("targetProductId")
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());

  const targetVariantIds = formData
    .getAll("targetVariantId")
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());

  const targets: CampaignTargetInput[] = [
    ...targetProductIds.map((id) => ({ productId: id, variantId: null })),
    ...targetVariantIds.map((id) => ({ productId: null, variantId: id })),
  ];

  // Bounded row count protection: take up to MAX_TARGETS_PER_CAMPAIGN + 1 so domain validator can catch TOO_MANY_TARGETS
  return targets.slice(0, MAX_TARGETS_PER_CAMPAIGN + 1);
}

export type StrictDateResult =
  | Readonly<{ ok: true; date: Date | null }>
  | Readonly<{ ok: false }>;

export function parseStrictVietnamDateTime(raw: unknown): StrictDateResult {
  if (raw === null || raw === undefined) return { ok: true, date: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, date: null };

  // Expect YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return { ok: false };

  const [, yStr, mStr, dStr, hStr, minStr, sStr] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(minStr);
  const second = sStr !== undefined ? Number(sStr) : 0;

  if (month < 1 || month > 12) return { ok: false };
  if (hour < 0 || hour > 23) return { ok: false };
  if (minute < 0 || minute > 59) return { ok: false };
  if (second < 0 || second > 59) return { ok: false };

  // Days in month validation (leap year aware)
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return { ok: false };

  // Asia/Ho_Chi_Minh is UTC+07:00
  // UTC timestamp: local hour - 7
  const utcMillis = Date.UTC(year, month - 1, day, hour - 7, minute, second);
  const date = new Date(utcMillis);
  if (Number.isNaN(date.getTime())) return { ok: false };

  return { ok: true, date };
}

export function parseVietnamDateTime(raw: unknown): Date | null {
  const result = parseStrictVietnamDateTime(raw);
  return result.ok ? result.date : null;
}

export function parseCampaignFormInput(formData: FormData): ParsedCampaignMutation {
  // 1. Kind: strict allowlist
  const rawKind = formData.get("kind");
  const kindStr = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!isPromotionCampaignKind(kindStr)) {
    return { ok: false, reason: "INVALID_CAMPAIGN_KIND" };
  }
  const kind = kindStr;

  // 2. Discount Type: strict allowlist
  const rawDiscountType = formData.get("discountType");
  const discountTypeStr = typeof rawDiscountType === "string" ? rawDiscountType.trim() : "";
  if (discountTypeStr !== "PERCENTAGE" && discountTypeStr !== "FIXED_PRICE") {
    return { ok: false, reason: "INVALID_DISCOUNT_TYPE" };
  }
  const discountType = discountTypeStr as "PERCENTAGE" | "FIXED_PRICE";

  // 3. Discount Value
  let percentageValue: number | null = null;
  let fixedPriceVnd: bigint | null = null;

  if (discountType === "PERCENTAGE") {
    const raw = formData.get("percentageValue");
    if (typeof raw === "string" && raw.trim().length > 0) {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) {
        return { ok: false, reason: "INVALID_PERCENTAGE" };
      }
      const num = Number(trimmed);
      if (!Number.isSafeInteger(num) || num < 1 || num > 99) {
        return { ok: false, reason: "INVALID_PERCENTAGE" };
      }
      percentageValue = num;
    }
  } else {
    // FIXED_PRICE
    const raw = formData.get("fixedPriceVnd");
    if (typeof raw === "string" && raw.trim().length > 0) {
      const trimmed = raw.trim();
      if (!/^[1-9]\d*$/.test(trimmed)) {
        return { ok: false, reason: "MALFORMED_FIXED_PRICE" };
      }
      try {
        fixedPriceVnd = BigInt(trimmed);
      } catch {
        return { ok: false, reason: "MALFORMED_FIXED_PRICE" };
      }
    }
  }

  // 4. Dates: strict Vietnam datetime with calendar correctness
  const startsAtRes = parseStrictVietnamDateTime(formData.get("startsAt"));
  if (!startsAtRes.ok) return { ok: false, reason: "INVALID_DATE_TIME" };
  const startsAt = startsAtRes.date;

  const endsAtRes = parseStrictVietnamDateTime(formData.get("endsAt"));
  if (!endsAtRes.ok) return { ok: false, reason: "INVALID_DATE_TIME" };
  const endsAt = endsAtRes.date;

  // 5. Name: preserve string, let validateDraftInput handle bounds
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName : "";

  // 6. Targets: parse without truncating IDs
  const targets = parseTargets(formData);

  return {
    ok: true,
    value: {
      name,
      kind,
      discountType,
      percentageValue,
      fixedPriceVnd,
      startsAt,
      endsAt,
      targets,
    },
  };
}
