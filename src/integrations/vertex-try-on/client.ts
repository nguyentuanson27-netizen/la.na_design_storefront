import { readBoundedBody, sniffImageMime } from "../../commerce/try-on-image.ts";
import type { TryOnImageMimeType } from "../../commerce/try-on-policy.ts";
import { createTimeoutSignal } from "./timeout.ts";

/**
 * The one Vertex AI boundary for virtual try-on (spec §3, §8).
 *
 * Deliberately not a provider framework: one model, one request shape, one response shape. A model
 * migration is a reviewed edit to this file. It never retries, never relaxes a provider control and
 * never falls back to another model — a safety refusal is final.
 *
 * Wire format: Vertex AI publisher-model `:predict` for `virtual-try-on-001`, as implemented by
 * Google's own SDK (`recontextImage`): `instances[0].personImage.image` and
 * `instances[0].productImages[].image` carry `bytesBase64Encoded`; `parameters` carries
 * `sampleCount`, `personGeneration`, `safetySetting`, `addWatermark`. The model exposes no prompt
 * (the SDK documents `prompt` as "Not supported for Virtual Try-On"), so none is sent: provider
 * safety filtering and the server-side age/likeness gates are the whole safety boundary.
 *
 * Images are held in memory for the life of one request. Nothing here writes them anywhere, and
 * `storageUri` is deliberately never set, so Vertex does not write output to Cloud Storage.
 */

export const TRY_ON_MODEL = "virtual-try-on-001";

/** One candidate per explicit shopper action. */
const SAMPLE_COUNT = 1;
/**
 * `allow-all` is required so the approved teen path is not blocked by the model's adult-only
 * default. Minor safety therefore rests on `safetySetting` below plus the server-side age gate.
 *
 * Spelling: the official `VirtualTryOnModelParams` REST reference documents the hyphenated values
 * (`dont-allow` / `allow-adult` / `allow-all`, `block-low-and-above` / ...). Note that Google's SDK
 * enums are `ALLOW_ALL` / `BLOCK_LOW_AND_ABOVE` and pass through unconverted, so they are not
 * evidence for the wire value. A test pins these exact strings; a live smoke test is still owed.
 */
const PERSON_GENERATION = "allow-all";
/** The strictest documented threshold. Never lowered to raise the success rate. */
const SAFETY_SETTING = "block-low-and-above";

/**
 * One budget for the whole provider phase (access token + prediction). Kept under the 60 s read
 * timeout reverse proxies default to, so a slow prediction ends as a clean TIMEOUT the shopper can
 * retry rather than a proxy-cut connection; the 10 s product-image fetch comes before it.
 */
const DEFAULT_TIMEOUT_MS = 45_000;
/** base64 of a ~7 MB image is ~9.5 MB; allow generous headroom for a larger output, but bound it. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * Known provider refusal wording only. Bare words such as "safety" or "policy" also appear in
 * request-validation errors (`invalid safetySetting`), and misreading one of those as a content
 * refusal would clear the shopper's photo and blame their content for an integration fault. A
 * 400 that matches none of these is an ordinary generation failure.
 *
 * Google's Responsible AI guide documents a filtered input as an HTTP 400 whose top-level message
 * says the content "violate[s] Google's Responsible AI practices", with the support code in
 * `error.details[].detail` rather than in `error.message`. Both places are read, and only those.
 */
const SAFETY_ERROR_PATTERN = new RegExp(
  [
    "blocked by (?:the )?safety filters?",
    "safety filter threshold",
    "violate[sd]? google['\\u2019]s responsible ai practices",
    "responsible ai (?:practices )?(?:filtered|blocked)",
    "support codes?: ?\\d+",
  ].join("|"),
  "i",
);
const MAX_ERROR_DETAILS_READ = 8;
const MAX_ERROR_TEXT_LENGTH = 4_000;

export type VertexTryOnImage = Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }>;

export type VertexTryOnFailureReason =
  | "SAFETY_BLOCKED"
  | "AUTH_FAILED"
  | "BUSY"
  | "TIMEOUT"
  | "GENERATION_FAILED";

export type VertexTryOnResult =
  | Readonly<{ ok: true; image: VertexTryOnImage }>
  | Readonly<{ ok: false; reason: VertexTryOnFailureReason }>;

type VertexLocation = Readonly<{ projectId: string; location: string }>;

function toBase64(image: VertexTryOnImage): string {
  return Buffer.from(image.bytes).toString("base64");
}

export function buildPredictRequest({
  config,
  person,
  product,
}: Readonly<{ config: VertexLocation; person: VertexTryOnImage; product: VertexTryOnImage }>) {
  const { projectId, location } = config;
  return {
    url: `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${TRY_ON_MODEL}:predict`,
    body: {
      instances: [
        {
          personImage: { image: { bytesBase64Encoded: toBase64(person) } },
          productImages: [{ image: { bytesBase64Encoded: toBase64(product) } }],
        },
      ],
      parameters: {
        sampleCount: SAMPLE_COUNT,
        personGeneration: PERSON_GENERATION,
        safetySetting: SAFETY_SETTING,
        addWatermark: true,
      },
    },
  };
}

/**
 * Settles with `work`, or rejects with the signal's reason as soon as the deadline passes. The work
 * itself cannot be cancelled (the auth library takes no signal), but racing it means a stall costs
 * the caller at most the deadline, and both branches are observed so a late failure of the
 * abandoned call is not an unhandled rejection.
 */
function raceDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      work.catch(() => undefined);
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function failed(reason: VertexTryOnFailureReason): VertexTryOnResult {
  return { ok: false, reason };
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBody(response.body, maxBytes);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The upstream error text is inspected for a safety signal and then discarded. Only the top-level
 * message and string `detail` fields of the first few `details` entries are read, each bounded.
 */
function errorSignalsSafetyBlock(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error)) return false;
  const texts: string[] = [];
  if (typeof body.error.message === "string") texts.push(body.error.message);
  if (Array.isArray(body.error.details)) {
    for (const entry of body.error.details.slice(0, MAX_ERROR_DETAILS_READ)) {
      if (isRecord(entry) && typeof entry.detail === "string") texts.push(entry.detail);
    }
  }
  return texts.some((text) => SAFETY_ERROR_PATTERN.test(text.slice(0, MAX_ERROR_TEXT_LENGTH)));
}

function parsePrediction(body: unknown): VertexTryOnResult {
  if (!isRecord(body) || !Array.isArray(body.predictions) || body.predictions.length !== 1) {
    return failed("GENERATION_FAILED");
  }
  const prediction: unknown = body.predictions[0];
  if (!isRecord(prediction)) return failed("GENERATION_FAILED");

  if (prediction.raiFilteredReason !== undefined) return failed("SAFETY_BLOCKED");

  const { bytesBase64Encoded, mimeType } = prediction;
  if (
    typeof bytesBase64Encoded !== "string" ||
    bytesBase64Encoded.length % 4 !== 0 ||
    !BASE64_PATTERN.test(bytesBase64Encoded)
  ) {
    return failed("GENERATION_FAILED");
  }

  const bytes = new Uint8Array(Buffer.from(bytesBase64Encoded, "base64"));
  const sniffed = sniffImageMime(bytes);
  // The bytes decide, and the provider's own label must agree with them.
  if (sniffed === null || mimeType !== sniffed) return failed("GENERATION_FAILED");
  return { ok: true, image: { bytes, mimeType: sniffed } };
}

export function createVertexTryOnClient({
  config,
  getAccessToken,
  fetch: doFetch = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: Readonly<{
  config: VertexLocation;
  getAccessToken: () => Promise<string>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}>) {
  /**
   * Exactly one provider call per invocation, under one deadline.
   *
   * The caller holds a generation slot for as long as this runs, so the deadline has to cover
   * everything that can stall: obtaining the access token (an ADC or service-account refresh is a
   * network call with no timeout of its own) as well as the prediction. One timer, started first,
   * so the two phases share a single budget and a stalled token refresh releases the slot on time.
   */
  async function generate({
    person,
    product,
  }: Readonly<{ person: VertexTryOnImage; product: VertexTryOnImage }>): Promise<VertexTryOnResult> {
    const timeout = createTimeoutSignal(timeoutMs);
    const { signal } = timeout;

    try {
      let token: string;
      try {
        token = await raceDeadline(getAccessToken(), signal);
      } catch (error) {
        return failed(isTimeout(error) ? "TIMEOUT" : "AUTH_FAILED");
      }

      const request = buildPredictRequest({ config, person, product });
      const response = await doFetch(request.url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal,
      });

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return failed("AUTH_FAILED");
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        return failed("BUSY");
      }
      if (response.status === 400) {
        const body = await readJson(response, MAX_ERROR_BODY_BYTES);
        return failed(errorSignalsSafetyBlock(body) ? "SAFETY_BLOCKED" : "GENERATION_FAILED");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return failed("GENERATION_FAILED");
      }

      return parsePrediction(await readJson(response, MAX_RESPONSE_BYTES));
    } catch (error) {
      return failed(isTimeout(error) ? "TIMEOUT" : "GENERATION_FAILED");
    } finally {
      timeout.clear();
    }
  }

  return { generate };
}
