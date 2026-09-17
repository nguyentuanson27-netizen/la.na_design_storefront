"use server";

import { createHmac, randomUUID } from "node:crypto";

import { headers } from "next/headers";

import { BRAND } from "@/brand";
import { prisma } from "@/db/prisma";

import {
  createContactDelivery,
  sendContactEmailViaResend,
  type ContactPayload,
  type ContactSubmissionResult,
} from "./contact-delivery";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

type RateLimitRow = { count: number };

async function consumeWindow(
  id: string,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<boolean> {
  const cutoff = BigInt(nowMs - windowMs);
  const now = BigInt(nowMs);

  const rows = await prisma.$queryRaw<RateLimitRow[]>`
    INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest")
    VALUES (${id}, ${key}, 1, ${now})
    ON CONFLICT ("id") DO UPDATE SET
      "count" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN 1
        ELSE "rateLimit"."count" + 1
      END,
      "lastRequest" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN ${now}
        ELSE "rateLimit"."lastRequest"
      END
    RETURNING "count"
  `;

  return rows.length === 1 && rows[0]!.count <= limit;
}

async function consumeContactRateLimits(clientBucket: string): Promise<boolean> {
  const nowMs = Date.now();
  const [shortWindowAllowed, dailyWindowAllowed] = await Promise.all([
    consumeWindow(
      `contact:15m:${clientBucket}`,
      `contact:15m:${clientBucket}`,
      3,
      FIFTEEN_MINUTES_MS,
      nowMs,
    ),
    consumeWindow(
      `contact:24h:${clientBucket}`,
      `contact:24h:${clientBucket}`,
      10,
      TWENTY_FOUR_HOURS_MS,
      nowMs,
    ),
  ]);

  return shortWindowAllowed && dailyWindowAllowed;
}

async function resolveClientBucket(secret: string): Promise<string | null> {
  const headerName = process.env.BETTER_AUTH_IP_HEADER?.trim().toLowerCase();

  if (!headerName) {
    if (process.env.NODE_ENV !== "production") {
      return createHmac("sha256", secret).update("local-development").digest("hex");
    }
    return null;
  }

  const value = (await headers()).get(headerName)?.trim();
  if (!value || value.includes(",")) return null;

  return createHmac("sha256", secret).update(value).digest("hex");
}

function createResendSender(apiKey: string) {
  return (payload: ContactPayload, idempotencyKey: string) =>
    sendContactEmailViaResend(payload, {
      apiKey,
      to: BRAND.contact.email,
      idempotencyKey,
    });
}

export async function submitContactForm(input: unknown): Promise<ContactSubmissionResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "DELIVERY_FAILED" };

  const clientBucket = await resolveClientBucket(apiKey);
  if (!clientBucket) return { ok: false, reason: "DELIVERY_FAILED" };

  const delivery = createContactDelivery({
    consumeRateLimits: consumeContactRateLimits,
    sendEmail: createResendSender(apiKey),
  });

  return delivery.submit(input, clientBucket, `contact-${randomUUID()}`);
}
