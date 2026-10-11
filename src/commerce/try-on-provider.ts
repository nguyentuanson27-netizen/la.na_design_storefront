export type VertexTryOnRuntimeConfig = Readonly<{
  available: true;
  provider: "vertex";
  projectId: string;
  location: string;
}>;

/**
 * Vertex AI as the overflow for Flow (owner decision 2026-10-11): a request goes to Vertex instead of
 * Flow only when it is routed there *before* anything is sent — Flow's one slot is taken, or Flow is
 * marked down after an auth failure or repeated failures. One shopper action never reaches both.
 * `dailyCap` bounds Vertex spend: past it, overflow is refused as BUSY as before.
 */
export type TryOnOverflowConfig = Readonly<{
  vertex: VertexTryOnRuntimeConfig;
  dailyCap: number;
}>;

export type FlowTryOnRuntimeConfig = Readonly<{
  available: true;
  provider: "flow";
  workerUrl: string;
  workerToken: string;
  /** Present only when Vertex overflow is configured in full; absent means Flow alone, as before. */
  overflow?: TryOnOverflowConfig;
}>;

export type AvailableTryOnRuntimeConfig = VertexTryOnRuntimeConfig | FlowTryOnRuntimeConfig;
export type TryOnProvider = AvailableTryOnRuntimeConfig["provider"];

/**
 * Which processors a shopper must be told about before they consent: one provider, or Flow with
 * Vertex as its overflow (the shopper cannot know in advance which of the two will serve them).
 */
export type TryOnDisclosedProviders = TryOnProvider | "flow-vertex";

export function disclosedTryOnProviders(config: AvailableTryOnRuntimeConfig): TryOnDisclosedProviders {
  return config.provider === "flow" && config.overflow !== undefined ? "flow-vertex" : config.provider;
}

export type TryOnRuntimeConfig =
  | AvailableTryOnRuntimeConfig
  | Readonly<{ available: false; reason: "DISABLED" | "NOT_CONFIGURED" }>;
