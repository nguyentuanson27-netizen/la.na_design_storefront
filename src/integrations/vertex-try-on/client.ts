import { readBoundedBody, sniffImageMime } from "../../commerce/try-on-image.ts";
import type { TryOnImageMimeType } from "../../commerce/try-on-policy.ts";
import { createTimeoutSignal } from "./timeout.ts";

/**
 * One Vertex AI boundary for virtual try-on.
 *
 * Nano Banana Pro is Gemini 3 Pro Image. The app sends two inline references and a fixed
 * server-owned prompt to generateContent. There is no model fallback, automatic retry, shopper
 * prompt, or provider storage URI.
 */
export const TRY_ON_MODEL = "gemini-3-pro-image";
export const TRY_ON_OUTPUT_IMAGE_SIZE = "2K";
export const TRY_ON_PROMPT =
  "Create one photorealistic virtual try-on image. " +
  "Reference image 1 is the shopper. Reference image 2 is the exact garment to put on the shopper. " +
  "Dress the shopper in exactly that garment while preserving the shopper's recognizable identity, face, hair, apparent age, skin tone, body proportions, pose, hands, framing, camera perspective, background and lighting. " +
  "Preserve the garment's silhouette, cut, length, color, pattern, texture, seams, trim, logos, graphics and visible design details. " +
  "Make only the clothing change needed for a physically plausible fit. Do not reshape the body, retouch the face, add or remove accessories, sexualize the subject, create nudity, or change apparent age. " +
  "Do not invent conspicuous garment details that are not visible in the reference. " +
  "Return one high-fidelity fashion visualization with no text, collage, split-screen or extra people.";

const SAFETY_THRESHOLD = "BLOCK_LOW_AND_ABOVE";
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: SAFETY_THRESHOLD },
] as const;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
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
const SAFETY_BLOCK_REASONS = new Set(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"]);
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

export function buildGenerateContentRequest({
  config,
  person,
  product,
}: Readonly<{ config: VertexLocation; person: VertexTryOnImage; product: VertexTryOnImage }>) {
  const { projectId, location } = config;
  return {
    url:
      "https://aiplatform.googleapis.com/v1/projects/" +
      projectId +
      "/locations/" +
      location +
      "/publishers/google/models/" +
      TRY_ON_MODEL +
      ":generateContent",
    body: {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Reference image 1: shopper." },
            { inlineData: { mimeType: person.mimeType, data: toBase64(person) } },
            { text: "Reference image 2: garment." },
            { inlineData: { mimeType: product.mimeType, data: toBase64(product) } },
            { text: TRY_ON_PROMPT },
          ],
        },
      ],
      generationConfig: {
        candidateCount: 1,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          imageSize: TRY_ON_OUTPUT_IMAGE_SIZE,
          imageOutputOptions: { mimeType: "image/png" },
          personGeneration: "allow_all",
        },
      },
      safetySettings: SAFETY_SETTINGS,
    },
  };
}

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
function hasSafetyBlock(body: Record<string, unknown>): boolean {
  if (isRecord(body.promptFeedback)) {
    const reason = body.promptFeedback.blockReason;
    if (typeof reason === "string" && SAFETY_BLOCK_REASONS.has(reason)) return true;
  }
  if (!Array.isArray(body.candidates)) return false;
  return body.candidates.some((candidate) => {
    if (!isRecord(candidate)) return false;
    if (typeof candidate.finishReason === "string" && SAFETY_BLOCK_REASONS.has(candidate.finishReason)) {
      return true;
    }
    return (
      Array.isArray(candidate.safetyRatings) &&
      candidate.safetyRatings.some((rating) => isRecord(rating) && rating.blocked === true)
    );
  });
}
function parseGeneratedImage(body: unknown): VertexTryOnResult {
  if (!isRecord(body)) return failed("GENERATION_FAILED");
  if (hasSafetyBlock(body)) return failed("SAFETY_BLOCKED");
  if (!Array.isArray(body.candidates) || body.candidates.length !== 1) {
    return failed("GENERATION_FAILED");
  }

  const candidate = body.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return failed("GENERATION_FAILED");
  }

  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of candidate.content.parts) {
    if (!isRecord(part) || !isRecord(part.inlineData)) continue;
    const { data, mimeType } = part.inlineData;
    if (typeof data === "string" && typeof mimeType === "string") images.push({ data, mimeType });
  }
  if (images.length !== 1) return failed("GENERATION_FAILED");

  const { data, mimeType } = images[0]!;
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return failed("GENERATION_FAILED");

  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const sniffed = sniffImageMime(bytes);
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

      const request = buildGenerateContentRequest({ config, person, product });
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
      return parseGeneratedImage(await readJson(response, MAX_RESPONSE_BYTES));
    } catch (error) {
      return failed(isTimeout(error) ? "TIMEOUT" : "GENERATION_FAILED");
    } finally {
      timeout.clear();
    }
  }

  return { generate };
}
