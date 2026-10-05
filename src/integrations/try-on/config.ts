import type { TryOnRuntimeConfig } from "../../commerce/try-on-provider.ts";
import { readTryOnConfig as readVertexTryOnConfig } from "../vertex-try-on/config.ts";

type TryOnEnvironment = Readonly<Record<string, string | undefined>>;

const FLOW_TOKEN_MIN_LENGTH = 32;

function parseWorkerUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    if (url.hostname.length === 0) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Server-only runtime choice for virtual try-on.
 *
 * Provider omission intentionally preserves the pre-existing Vertex behavior. Flow is opt-in and
 * fails closed unless both the private worker origin and a high-entropy bearer token are present.
 */
export function readTryOnRuntimeConfig(env: TryOnEnvironment = process.env): TryOnRuntimeConfig {
  if (env.LA_TRY_ON_ENABLED !== "true") return { available: false, reason: "DISABLED" };

  const provider = env.LA_TRY_ON_PROVIDER ?? "vertex";
  if (provider === "vertex") {
    const vertex = readVertexTryOnConfig(env);
    return vertex.available
      ? { available: true, provider: "vertex", projectId: vertex.projectId, location: vertex.location }
      : vertex;
  }

  if (provider !== "flow") return { available: false, reason: "NOT_CONFIGURED" };

  const workerUrl = parseWorkerUrl(env.LA_TRY_ON_FLOW_URL);
  const workerToken = env.LA_TRY_ON_FLOW_TOKEN;
  if (
    workerUrl === null ||
    workerToken === undefined ||
    workerToken.length < FLOW_TOKEN_MIN_LENGTH ||
    workerToken.trim() !== workerToken
  ) {
    return { available: false, reason: "NOT_CONFIGURED" };
  }

  return { available: true, provider: "flow", workerUrl, workerToken };
}
