const PANCAKE_API_BASE_URL = "https://pos.pages.fm/api/v1";
const PANCAKE_API_BASE = new URL(`${PANCAKE_API_BASE_URL}/`);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

type QueryValue = string | number | boolean;
type Fetcher = typeof fetch;
type PostJsonOptions = Readonly<{ expectedStatus?: number | readonly number[] }>;

export class PancakeHttpError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string) {
    super(`Pancake request failed with status ${status} for ${endpoint}`);
    this.name = "PancakeHttpError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

function matchesExpectedStatus(
  status: number,
  expectedStatus: number | readonly number[] | undefined,
): boolean {
  if (expectedStatus === undefined) return true;
  return typeof expectedStatus === "number"
    ? status === expectedStatus
    : expectedStatus.includes(status);
}

export class PancakeNetworkError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Pancake request could not be completed for ${endpoint}`);
    this.name = "PancakeNetworkError";
    this.endpoint = endpoint;
  }
}

export class PancakeClient {
  private readonly apiKey: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor({
    apiKey,
    fetcher = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: {
    apiKey: string;
    fetcher?: Fetcher;
    timeoutMs?: number;
  }) {
    if (!apiKey.trim()) {
      throw new TypeError("Pancake API key is required");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("Pancake request timeout must be a positive integer");
    }
    if (timeoutMs > MAX_NODE_TIMER_DELAY_MS) {
      throw new TypeError(
        `Pancake request timeout must not exceed ${MAX_NODE_TIMER_DELAY_MS} milliseconds`,
      );
    }

    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async getJson(endpoint: string, query: Readonly<Record<string, QueryValue>> = {}): Promise<unknown> {
    const url = this.buildUrl(endpoint, query);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PancakeNetworkError(endpoint);
    }

    if (!response.ok) {
      throw new PancakeHttpError(response.status, endpoint);
    }

    return response.json() as Promise<unknown>;
  }

  async postJson(endpoint: string, body: unknown, options: PostJsonOptions = {}): Promise<unknown> {
    const url = this.buildUrl(endpoint, {});
    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      throw new TypeError("Pancake JSON request body must be serializable");
    }
    if (serializedBody === undefined) {
      throw new TypeError("Pancake JSON request body must be serializable");
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: serializedBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PancakeNetworkError(endpoint);
    }

    if (!response.ok || !matchesExpectedStatus(response.status, options.expectedStatus)) {
      throw new PancakeHttpError(response.status, endpoint);
    }

    return response.json() as Promise<unknown>;
  }

  async putJson(endpoint: string, body: unknown, options: PostJsonOptions = {}): Promise<unknown> {
    const url = this.buildUrl(endpoint, {});
    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      throw new TypeError("Pancake JSON request body must be serializable");
    }
    if (serializedBody === undefined) {
      throw new TypeError("Pancake JSON request body must be serializable");
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "PUT",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: serializedBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PancakeNetworkError(endpoint);
    }

    if (!response.ok || !matchesExpectedStatus(response.status, options.expectedStatus)) {
      throw new PancakeHttpError(response.status, endpoint);
    }

    return response.json() as Promise<unknown>;
  }

  private buildUrl(endpoint: string, query: Readonly<Record<string, QueryValue>>): URL {
    if (
      !endpoint.startsWith("/") ||
      endpoint.startsWith("//") ||
      endpoint.includes("..") ||
      endpoint.includes("\\") ||
      endpoint.includes("?") ||
      endpoint.includes("#")
    ) {
      throw new TypeError("Pancake endpoint must start with / and contain only a path");
    }

    const url = new URL(`${PANCAKE_API_BASE_URL}${endpoint}`);
    if (url.origin !== PANCAKE_API_BASE.origin || !url.pathname.startsWith(PANCAKE_API_BASE.pathname)) {
      throw new TypeError("Pancake endpoint must remain within the API prefix after canonicalization");
    }

    url.searchParams.set("api_key", this.apiKey);

    for (const [key, value] of Object.entries(query)) {
      if (key === "api_key") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url;
  }
}
