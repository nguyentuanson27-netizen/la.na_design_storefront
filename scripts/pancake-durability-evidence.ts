import { pathToFileURL } from "node:url";

import { createCatalogMirrorRepository } from "../src/commerce/catalog-mirror-repository.ts";
import { syncPancakeCatalog } from "../src/commerce/catalog-sync.ts";
import {
  assertDurabilityEvidenceEnvironment,
  compareCatalogSnapshots,
  createCatalogIdSnapshot,
  type CatalogIdSnapshot,
} from "../src/commerce/merchant-identity-durability.ts";
import { PancakeClient } from "../src/integrations/pancake/client.ts";
import { readPancakeConfig } from "../src/integrations/pancake/config.ts";

const RUNS_COUNT = 3;

export async function runDurabilityEvidence(options: {
  runs?: number;
  delayMs?: number;
} = {}): Promise<ReturnType<typeof compareCatalogSnapshots>> {
  // Fail closed: enforce CI refusal and approved isolated audit database BEFORE reading config or Prisma
  assertDurabilityEvidenceEnvironment();

  const config = readPancakeConfig();
  const pancake = new PancakeClient({ apiKey: config.apiKey });

  // Imported only once the guard has passed, and owned from here on. A client built after a refusal
  // is built from the very connection string the guard rejected, so its lifetime belongs inside the
  // guarded path rather than to a caller that cannot know whether the guard ran.
  const { prisma } = await import("../src/db/prisma.ts");

  try {
    return await collectDurabilityEvidence({ prisma, pancake, config, options });
  } finally {
    await prisma.$disconnect();
  }
}

async function collectDurabilityEvidence({
  prisma,
  pancake,
  config,
  options,
}: {
  prisma: Awaited<typeof import("../src/db/prisma.ts")>["prisma"];
  pancake: PancakeClient;
  config: ReturnType<typeof readPancakeConfig>;
  options: { runs?: number; delayMs?: number };
}): Promise<ReturnType<typeof compareCatalogSnapshots>> {
  const repository = createCatalogMirrorRepository(prisma);
  const runs = options.runs ?? RUNS_COUNT;
  const delayMs = options.delayMs ?? 1000;

  const snapshots: CatalogIdSnapshot[] = [];

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    // Sampled here and handed in as the clock, so the timestamp this run's evidence is labelled
    // with is the exact marker stamped onto the mirrored rows.
    const runStartedAt = new Date();
    await syncPancakeCatalog({
      client: pancake,
      repository,
      shopId: config.shopId,
      clock: () => runStartedAt,
    });

    const products = await prisma.productMirror.findMany({
      where: { pancakeShopId: config.shopId, isPresent: true },
      select: { pancakeProductId: true },
      orderBy: { pancakeProductId: "asc" },
    });

    const variants = await prisma.variantMirror.findMany({
      where: {
        isPresent: true,
        product: { is: { pancakeShopId: config.shopId, isPresent: true } },
      },
      select: { pancakeVariationId: true, id: true },
      orderBy: { pancakeVariationId: "asc" },
    });

    const internalVariantIdMap: Record<string, string> = {};
    for (const v of variants) {
      internalVariantIdMap[v.pancakeVariationId] = v.id;
    }

    const snapshot = createCatalogIdSnapshot({
      runIndex,
      timestamp: runStartedAt.toISOString(),
      shopId: config.shopId,
      productExternalIds: products.map((p) => p.pancakeProductId),
      variationExternalIds: variants.map((v) => v.pancakeVariationId),
      internalVariantIdMap,
    });

    snapshots.push(snapshot);

    if (runIndex < runs - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return compareCatalogSnapshots(snapshots);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    assertDurabilityEvidenceEnvironment();
    const result = await runDurabilityEvidence();
    console.log("PANCAKE_DURABILITY_EVIDENCE_BEGIN");
    console.log(JSON.stringify(result, null, 2));
    console.log("PANCAKE_DURABILITY_EVIDENCE_END");
  } catch (error) {
    console.error(`Durability evidence failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
  // No cleanup here on purpose. The wrapper cannot know whether the guard ever passed, so importing
  // Prisma to disconnect would construct a client against the refused database — undoing most of
  // what the refusal was for. Whatever creates the client also closes it.
}
