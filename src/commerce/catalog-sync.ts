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
    availabilityObservedAt: Date;
  }): Promise<{ products: number; variations: number }>;
};

/**
 * Mirror the Pancake catalog.
 *
 * `clock` is read **once, here, immediately before the first Pancake request**, and the value it
 * returns is stamped onto every row this run writes. That ordering is the contract, not a
 * convention: ADR 0014 §4.1 retires a committed capacity reservation only once a stock observation
 * that *began* after the commit has landed, so a marker taken at write time would claim freshness a
 * pre-commit snapshot does not have and release the hold early — the units would then be counted by
 * neither side.
 *
 * The marker used to be a `syncedAt: Date` parameter. That made the guarantee a call-site
 * convention: `syncConfiguredPancakeCatalog()` happened to evaluate its default before calling in,
 * but nothing said it had to, and the name invited a caller to pass the instant the write finished.
 * Taking a clock instead makes a post-fetch reading unrepresentable — a caller can decide *what*
 * time source is used, never *when* it is sampled.
 *
 * Injecting the clock remains possible so tests and evidence scripts can pin a deterministic value.
 * That is a fixed instant, which is still a read-start marker; it is not a reading taken after the
 * response came back.
 */
export async function syncPancakeCatalog({
  client,
  repository,
  shopId,
  clock = () => new Date(),
  availabilityClock = () => new Date(),
}: {
  client: CatalogClient;
  repository: CatalogMirrorWriter;
  shopId: number;
  clock?: () => Date;
  availabilityClock?: () => Date;
}) {
  // Before the first read, deliberately. Moving this line below either fetch reintroduces exactly
  // the hazard ADR 0014 §4.2 exists to close.
  const syncedAt = clock();

  const variations = await fetchAllPancakeCatalogVariations({ client, shopId });
  const compositeSnapshot = await fetchPancakeCompositeSnapshot({ client, shopId });

  // I9 is a different fact from G5 freshness: this instant answers when the website had a complete,
  // validated snapshot available to observe, so it is deliberately sampled after all Pancake reads.
  const availabilityObservedAt = availabilityClock();

  return repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot,
    syncedAt,
    availabilityObservedAt,
  });
}
