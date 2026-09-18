import type { MarkerSearchResult } from "../src/integrations/pancake/order-search.ts";

type MarkerSearchGateway = {
  searchOrderByMarker(shopId: number, marker: string): Promise<MarkerSearchResult>;
};

export async function recoverOrderIdByMarker({
  gateway,
  shopId,
  marker,
  attempts = 5,
  delayMs = 1000,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  gateway: MarkerSearchGateway;
  shopId: number;
  marker: string;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await gateway.searchOrderByMarker(shopId, marker);
    if (result.kind === "FOUND") return result.orderId;
    if (attempt < attempts) await sleep(delayMs);
  }
  return null;
}
