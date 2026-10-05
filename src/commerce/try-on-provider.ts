export type VertexTryOnRuntimeConfig = Readonly<{
  available: true;
  provider: "vertex";
  projectId: string;
  location: string;
}>;

export type FlowTryOnRuntimeConfig = Readonly<{
  available: true;
  provider: "flow";
  workerUrl: string;
  workerToken: string;
}>;

export type AvailableTryOnRuntimeConfig = VertexTryOnRuntimeConfig | FlowTryOnRuntimeConfig;

export type TryOnRuntimeConfig =
  | AvailableTryOnRuntimeConfig
  | Readonly<{ available: false; reason: "DISABLED" | "NOT_CONFIGURED" }>;
