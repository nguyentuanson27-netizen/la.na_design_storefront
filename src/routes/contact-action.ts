"use server";

import { createHmac, randomUUID } from "node:crypto";

import { headers } from "next/headers";

import { BRAND } from "@/brand";
import {
  createContactDelivery,
  sendContactEmailViaResend,
  type ContactPayload,
  type ContactSubmissionResult,
} from "@/contact/contact-delivery";
import { consumeContactRateLimits } from "@/contact/contact-rate-limit";

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
      subject: `Liên hệ website ${BRAND.identity.name}`,
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
