import { readBoundedBody, sniffImageMime } from "../../commerce/try-on-image.ts";
import type { TryOnFailureReason, TryOnImageMimeType } from "../../commerce/try-on-policy.ts";
import type { FlowTryOnRuntimeConfig } from "../../commerce/try-on-provider.ts";

type Image = Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }>;
type FlowFailureReason = Extract<
  TryOnFailureReason,
  "SAFETY_BLOCKED" | "AUTH_FAILED" | "BUSY" | "TIMEOUT" | "GENERATION_FAILED"
>;

type GenerateResult =
  | Readonly<{ ok: true; image: Image }>
  | Readonly<{ ok: false; reason: FlowFailureReason }>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The worker's per-request generation budget is 120 s (FLOW_COMMAND_TIMEOUT_SECONDS), shared by
 * the Pro attempt and any Nano 2 fallback. Keep the caller slightly above it so the worker reports
 * a typed timeout and releases its Chrome/profile lock before the HTTP caller gives up.
 */
const DEFAULT_TIMEOUT_MS = 130_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const ALLOWED_MODELS = new Set(["nano-banana-pro", "nano-banana-2"]);
const ALLOWED_FAILURES = new Set([
  "SAFETY_BLOCKED",
  "AUTH_FAILED",
  "BUSY",
  "TIMEOUT",
  "GENERATION_FAILED",
]);

function failed(reason: FlowFailureReason): GenerateResult {
  return { ok: false, reason };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function parseFailure(status: number, body: unknown): GenerateResult {
  if (
    typeof body === "object" &&
    body !== null &&
    "reason" in body &&
    typeof body.reason === "string" &&
    ALLOWED_FAILURES.has(body.reason)
  ) {
    return failed(body.reason as FlowFailureReason);
  }

  if (status === 401 || status === 403) return failed("AUTH_FAILED");
  if (status === 409 || status === 429) return failed("BUSY");
  if (status === 422) return failed("SAFETY_BLOCKED");
  if (status === 504) return failed("TIMEOUT");
  return failed("GENERATION_FAILED");
}

function parseSuccess(body: unknown): GenerateResult {
  if (typeof body !== "object" || body === null) return failed("GENERATION_FAILED");
  const value = body as Record<string, unknown>;
  if (
    value.ok !== true ||
    typeof value.model !== "string" ||
    !ALLOWED_MODELS.has(value.model) ||
    (value.mimeType !== "image/jpeg" && value.mimeType !== "image/png") ||
    typeof value.imageBase64 !== "string" ||
    value.imageBase64.length === 0 ||
    value.imageBase64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value.imageBase64)
  ) {
    return failed("GENERATION_FAILED");
  }

  const bytes = new Uint8Array(Buffer.from(value.imageBase64, "base64"));
  if (bytes.byteLength === 0 || sniffImageMime(bytes) !== value.mimeType) {
    return failed("GENERATION_FAILED");
  }
  return { ok: true, image: { bytes, mimeType: value.mimeType } };
}

export function createGoogleFlowTryOnClient({
  config,
  fetch: injectedFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: Readonly<{
  config: FlowTryOnRuntimeConfig;
  fetch?: FetchLike;
  timeoutMs?: number;
}>) {
  const doFetch: FetchLike = injectedFetch ?? ((input, init) => fetch(input, init));

  async function generate({ person, product }: Readonly<{ person: Image; product: Image }>): Promise<GenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Flow worker deadline exceeded", "TimeoutError")),
      timeoutMs,
    );

    try {
      const response = await doFetch(`${config.workerUrl}/v1/try-on`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.workerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          person: {
            mimeType: person.mimeType,
            imageBase64: Buffer.from(person.bytes).toString("base64"),
          },
          product: {
            mimeType: product.mimeType,
            imageBase64: Buffer.from(product.bytes).toString("base64"),
          },
        }),
      });

      const bytes = await readBoundedBody(response.body, MAX_RESPONSE_BYTES, { signal: controller.signal });
      if (bytes === null) return failed("GENERATION_FAILED");

      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return failed("GENERATION_FAILED");
      }

      return response.ok ? parseSuccess(body) : parseFailure(response.status, body);
    } catch (error) {
      return failed(isTimeout(error) || controller.signal.aborted ? "TIMEOUT" : "GENERATION_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }

  return { generate };
}
