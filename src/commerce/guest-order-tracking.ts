import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  buildHistoricalPreorderPresentation,
  type HistoricalPreorderPresentation,
} from "./historical-preorder-presentation.ts";

const MAX_PUBLIC_CODE_LENGTH = 128;
const MAX_PHONE_LENGTH = 64;

type LocalOrderState =
  | "DRAFT"
  | "VALIDATING"
  | "POS_SUBMITTING"
  | "CONFIRMED"
  | "REJECTED"
  | "SYNC_UNKNOWN";

export type GuestOrderPublicStatus =
  | "PROCESSING"
  | "CONFIRMED"
  | "CHECKING"
  | "REJECTED";

export type GuestOrderTrackingInput = Readonly<{
  orderCode: string;
  phone: string;
}>;

export type GuestOrderTrackingResult =
  | {
      ok: true;
      order: {
        orderCode: string;
        status: GuestOrderPublicStatus;
        createdAt: string;
        totalVnd: string;
        /** Present only when a confirmed I7 snapshot contains preorder history. */
        preorderHistory?: HistoricalPreorderPresentation;
      };
    }
  | { ok: false; reason: "NOT_FOUND" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

export function parseGuestOrderTrackingInput(
  input: unknown,
):
  | { ok: true; value: GuestOrderTrackingInput }
  | { ok: false; reason: "NOT_FOUND" } {
  if (!isRecord(input)) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const orderCode = parseBoundedText(input.orderCode, MAX_PUBLIC_CODE_LENGTH);
  const phone = parseBoundedText(input.phone, MAX_PHONE_LENGTH);
  if (!orderCode || !phone) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  return { ok: true, value: { orderCode, phone } };
}

export function toGuestOrderPublicStatus(state: LocalOrderState): GuestOrderPublicStatus {
  switch (state) {
    case "DRAFT":
    case "VALIDATING":
    case "POS_SUBMITTING":
      return "PROCESSING";
    case "CONFIRMED":
      return "CONFIRMED";
    case "SYNC_UNKNOWN":
      return "CHECKING";
    case "REJECTED":
      return "REJECTED";
  }
}

export function createGuestOrderTrackingService(client: PrismaClient) {
  async function lookup(input: unknown): Promise<GuestOrderTrackingResult> {
    const parsed = parseGuestOrderTrackingInput(input);
    if (!parsed.ok) return parsed;

    const order = await client.orderMirror.findFirst({
      where: {
        publicCode: parsed.value.orderCode,
        guestPhone: parsed.value.phone,
        userId: null,
      },
      select: {
        publicCode: true,
        state: true,
        createdAt: true,
        checkoutSnapshottedAt: true,
        totalVnd: true,
        preorderSnapshot: {
          select: {
            confirmedAt: true,
            preorderReadyAt: true,
            shippingInnerCityMinDays: true,
            shippingInnerCityMaxDays: true,
            shippingOtherProvinceMinDays: true,
            shippingOtherProvinceMaxDays: true,
            lines: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                variantId: true,
                quantity: true,
                state: true,
                preorderReadyAt: true,
              },
            },
          },
        },
      },
    });

    if (
      !order ||
      order.checkoutSnapshottedAt === null ||
      order.totalVnd === null ||
      order.totalVnd < BigInt(0)
    ) {
      return { ok: false, reason: "NOT_FOUND" };
    }

    const preorderHistory =
      order.state === "CONFIRMED"
        ? buildHistoricalPreorderPresentation(order.preorderSnapshot)
        : null;

    return {
      ok: true,
      order: {
        orderCode: order.publicCode,
        status: toGuestOrderPublicStatus(order.state),
        createdAt: order.createdAt.toISOString(),
        totalVnd: order.totalVnd.toString(),
        ...(preorderHistory ? { preorderHistory } : {}),
      },
    };
  }

  return { lookup };
}
