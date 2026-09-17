import type { PancakeParsedCatalogVariation } from "../integrations/pancake/catalog-contract.ts";
import { fetchAllPancakeCatalogVariations } from "../integrations/pancake/catalog-pages.ts";
import type { PancakeCompositeSnapshot } from "../integrations/pancake/composite-contract.ts";
import { fetchPancakeCompositeSnapshot } from "../integrations/pancake/composite-pages.ts";

type QueryValue = string | number | boolean;
type CatalogClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
};

type CatalogMirrorWriter = {
  syncSnapshot(input: {
    shopId: number;
    variations: readonly PancakeParsedCatalogVariation[];
    compositeSnapshot: PancakeCompositeSnapshot;
    syncedAt: Date;
  }): Promise<{ products: number; variations: number }>;
};

/**
 * @param syncedAt Stamped onto every mirrored row this run writes.
 *
 * Callers must capture it **before** the Pancake reads below are issued, never after they return.
 * ADR 0014 §4.1 retires a committed capacity reservation only once a stock observation that *began*
 * after the commit has landed, so a marker taken at write time would claim freshness a pre-commit
 * snapshot does not have and release the hold early. `syncConfiguredPancakeCatalog()` satisfies this
 * by evaluating its default before calling in; ADR 0014 §4.2 tracks making it a real contract rather
 * than a call-site convention.
 */
export async function syncPancakeCatalog({
  client,
  repository,
  shopId,
  syncedAt,
}: {
  client: CatalogClient;
  repository: CatalogMirrorWriter;
  shopId: number;
  syncedAt: Date;
}) {
  const variations = await fetchAllPancakeCatalogVariations({ client, shopId });
  const compositeSnapshot = await fetchPancakeCompositeSnapshot({ client, shopId });
  return repository.syncSnapshot({ shopId, variations, compositeSnapshot, syncedAt });
}
