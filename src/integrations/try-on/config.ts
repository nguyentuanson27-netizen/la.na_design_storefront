import type { TryOnOverflowConfig, TryOnRuntimeConfig } from "../../commerce/try-on-provider.ts";
import { readTryOnConfig as readVertexTryOnConfig } from "../vertex-try-on/config.ts";

type TryOnEnvironment = Readonly<Record<string, string | undefined>>;

const FLOW_TOKEN_MIN_LENGTH = 32;
/** Never send the shared worker bearer token to an arbitrary operator-configured public host. */
const FLOW_WORKER_HOSTS = new Set(["flow-worker", "localhost", "127.0.0.1"]);

function parseWorkerUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    if (!FLOW_WORKER_HOSTS.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A whole number of generations per day, 1..10 000; anything else disables overflow. */
const DAILY_CAP_PATTERN = /^[1-9][0-9]{0,4}$/;

/**
 * Vertex overflow for Flow: on only with `LA_TRY_ON_OVERFLOW_PROVIDER=vertex`, a complete Vertex
 * configuration and an explicit `LA_TRY_ON_VERTEX_DAILY_CAP`. Anything missing leaves Flow alone,
 * exactly as before — an incomplete overflow never makes Flow unavailable.
 */
function readOverflow(env: TryOnEnvironment): TryOnOverflowConfig | null {
  if (env.LA_TRY_ON_OVERFLOW_PROVIDER !== "vertex") return null;
  const cap = env.LA_TRY_ON_VERTEX_DAILY_CAP ?? "";
  if (!DAILY_CAP_PATTERN.test(cap) || Number(cap) > 10_000) return null;
  const vertex = readVertexTryOnConfig(env);
  if (!vertex.available) return null;
  return {
    vertex: { available: true, provider: "vertex", projectId: vertex.projectId, location: vertex.location },
    dailyCap: Number(cap),
  };
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

  const overflow = readOverflow(env);
  return overflow === null
    ? { available: true, provider: "flow", workerUrl, workerToken }
    : { available: true, provider: "flow", workerUrl, workerToken, overflow };
}
