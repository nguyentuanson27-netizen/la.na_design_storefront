export type ContactPayload = Readonly<{
  name: string;
  email: string;
  message: string;
}>;

export type ContactSubmissionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "RATE_LIMITED" | "DELIVERY_FAILED" }>;

type ValidationResult =
  | Readonly<{ ok: true; value: ContactPayload }>
  | Readonly<{ ok: false }>;

type ProviderResult =
  | Readonly<{ ok: true; id: string }>
  | Readonly<{ ok: false; reason: "NETWORK_ERROR" | "PROVIDER_ERROR"; status?: number }>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEADER_CONTROL = /[\u0000-\u001f\u007f]/;
const APPROVED_KEYS = new Set(["name", "email", "message"]);
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_USER_AGENT = "la-na-design-contact/1.0";
const FROM_ADDRESS = "website@lanadesign.vn";

function codePointLength(value: string): number {
  return [...value].length;
}

export function validateContactPayload(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false };
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== APPROVED_KEYS.size || keys.some((key) => !APPROVED_KEYS.has(key))) {
    return { ok: false };
  }

  if (
    typeof record.name !== "string" ||
    typeof record.email !== "string" ||
    typeof record.message !== "string"
  ) {
    return { ok: false };
  }

  const name = record.name.trim();
  const email = record.email.trim();
  const message = record.message.trim();

  if (codePointLength(name) < 1 || codePointLength(name) > 100) return { ok: false };
  if (
    email.length < 1 ||
    email.length > 254 ||
    HEADER_CONTROL.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    return { ok: false };
  }
  if (codePointLength(message) < 1 || codePointLength(message) > 4_000) return { ok: false };

  return { ok: true, value: { name, email, message } };
}

export async function sendContactEmailViaResend(
  payload: ContactPayload,
  options: Readonly<{
    apiKey: string;
    to: string;
    idempotencyKey: string;
    fetchImpl?: typeof fetch;
  }>,
): Promise<ProviderResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
        "User-Agent": RESEND_USER_AGENT,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [options.to],
        reply_to: payload.email,
        subject: "Liên hệ website La.na Design",
        text: `Tên: ${payload.name}\nEmail: ${payload.email}\n\n${payload.message}`,
      }),
    });
  } catch {
    return { ok: false, reason: "NETWORK_ERROR" };
  }

  if (!response.ok) {
    return { ok: false, reason: "PROVIDER_ERROR", status: response.status };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "PROVIDER_ERROR", status: response.status };
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { id?: unknown }).id !== "string" ||
    (body as { id: string }).id.length < 1 ||
    (body as { id: string }).id.length > 256
  ) {
    return { ok: false, reason: "PROVIDER_ERROR", status: response.status };
  }

  return { ok: true, id: (body as { id: string }).id };
}

export function createContactDelivery(dependencies: Readonly<{
  consumeRateLimits: (clientBucket: string) => Promise<boolean>;
  sendEmail: (payload: ContactPayload, idempotencyKey: string) => Promise<ProviderResult>;
}>) {
  return {
    async submit(
      input: unknown,
      clientBucket: string,
      idempotencyKey: string,
    ): Promise<ContactSubmissionResult> {
      const validated = validateContactPayload(input);
      if (!validated.ok) return { ok: false, reason: "INVALID_INPUT" };

      if (!(await dependencies.consumeRateLimits(clientBucket))) {
        return { ok: false, reason: "RATE_LIMITED" };
      }

      const result = await dependencies.sendEmail(validated.value, idempotencyKey);
      return result.ok ? { ok: true } : { ok: false, reason: "DELIVERY_FAILED" };
    },
  };
}
