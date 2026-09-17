import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig } from "../integrations/pancake/config.ts";
import { createCatalogMirrorRepository } from "./catalog-mirror-repository.ts";
import { syncPancakeCatalog } from "./catalog-sync.ts";

/**
 * `clock` is forwarded rather than a timestamp: `syncPancakeCatalog()` samples it immediately before
 * the first Pancake read, which is what makes the stock-observation marker a read-start fact rather
 * than a write-time one (ADR 0014 §4.2).
 */
export async function syncConfiguredPancakeCatalog({
  clock,
}: {
  clock?: () => Date;
} = {}) {
  const config = readPancakeConfig();
  const client = new PancakeClient({ apiKey: config.apiKey });
  const repository = createCatalogMirrorRepository(prisma);

  return syncPancakeCatalog({
    client,
    repository,
    shopId: config.shopId,
    ...(clock ? { clock } : {}),
  });
}
