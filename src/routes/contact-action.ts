"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import { readAuthServerConfig } from "@/auth/config";
import { BRAND } from "@/brand";
import { deriveGuestCheckoutClientKey as deriveTrustedClientKey } from "@/commerce/guest-checkout-client-identity";
import {
  createContactDelivery,
  sendContactEmailViaResend,
  validateContactPayload,
  type ContactPayload,
  type ContactSubmissionResult,
} from "@/contact/contact-delivery";
import { consumeContactRateLimits } from "@/contact/contact-rate-limit";

async function resolveClientBucket(): Promise<string | null> {
  try {
    return deriveTrustedClientKey(await headers(), readAuthServerConfig());
  } catch {
    return null;
  }
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
  const validated = validateContactPayload(input);
  if (!validated.ok) {
    return { ok: false, reason: "INVALID_INPUT", field: validated.field };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "DELIVERY_FAILED" };

  const clientBucket = await resolveClientBucket();
  if (!clientBucket) return { ok: false, reason: "DELIVERY_FAILED" };

  const delivery = createContactDelivery({
    consumeRateLimits: consumeContactRateLimits,
    sendEmail: createResendSender(apiKey),
  });

  return delivery.submit(validated.value, clientBucket, `contact-${randomUUID()}`);
}
