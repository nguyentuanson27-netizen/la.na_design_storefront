import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { normalizedSkuSql } from "./sku-sql.ts";

/**
 * Of `skus` (already normalized), the ones shared by more than one primary variant still on sale.
 *
 * This is the same 1:1 rule the secondary inventory sync applies, so checkout and the mirror never
 * disagree: stock of a SKU that cannot be tied to a single primary variant is given to none of them.
 * `normalizedSkuSql` is `normalizeSku` on the database side, character for character (see
 * `integrations/pancake/sku.ts`), so a SKU with a tab or no-break space around it is still the
 * same SKU here as in JavaScript.
 */
export async function findAmbiguousPrimarySkus(
  client: Pick<PrismaClient, "$queryRaw">,
  primaryShopId: number,
  skus: readonly string[],
): Promise<ReadonlySet<string>> {
  if (skus.length === 0) return new Set();
  const rows = await client.$queryRaw<Array<{ sku: string }>>(Prisma.sql`
    SELECT ${normalizedSkuSql(Prisma.sql`v."pancakeDisplayId"`)} AS sku
    FROM "VariantMirror" v
    JOIN "ProductMirror" p ON p."id" = v."productId"
    WHERE p."pancakeShopId" = ${primaryShopId}
      AND v."isPresent" = true
      AND ${normalizedSkuSql(Prisma.sql`v."pancakeDisplayId"`)} IN (${Prisma.join([...skus])})
    GROUP BY 1
    HAVING count(*) > 1
  `);
  return new Set(rows.map((row) => row.sku));
}

export type LiveSkuEntry = Readonly<{ variationId: string; sku: string }>;

/**
 * Of the (variation, normalized SKU) pairs a checkout just read LIVE from the primary POS, the SKUs
 * whose secondary stock must not be given out:
 *
 * - SKUs shared by more than one present variant in the mirror (`findAmbiguousPrimarySkus`);
 * - SKUs of an entry the mirror does not agree with: the variation is unknown to it, not present in
 *   it, or stored under another SKU. The mirror's ambiguity answer is about the mirror's own picture,
 *   which a rename in the POS has just made stale, so for these it proves nothing and the SKU is
 *   left without secondary stock until the next primary sync brings the mirror up to date.
 *
 * What it cannot see is a variant that is NOT in this request and was renamed to one of these SKUs
 * in the POS since the last sync; the primary sync's cleanup removes that case at its next run.
 */
export async function findUnsafePrimarySkus(
  client: Pick<PrismaClient, "$queryRaw">,
  primaryShopId: number,
  entries: readonly LiveSkuEntry[],
): Promise<ReadonlySet<string>> {
  if (entries.length === 0) return new Set();
  const skus = [...new Set(entries.map(({ sku }) => sku))];
  const unsafe = new Set(await findAmbiguousPrimarySkus(client, primaryShopId, skus));

  const variationIds = [...new Set(entries.map(({ variationId }) => variationId))];
  const rows = await client.$queryRaw<Array<{ id: string; sku: string | null; present: boolean }>>(Prisma.sql`
    SELECT v."pancakeVariationId" AS id,
           ${normalizedSkuSql(Prisma.sql`v."pancakeDisplayId"`)} AS sku,
           v."isPresent" AS present
    FROM "VariantMirror" v
    JOIN "ProductMirror" p ON p."id" = v."productId"
    WHERE p."pancakeShopId" = ${primaryShopId}
      AND v."pancakeVariationId" IN (${Prisma.join(variationIds)})
  `);
  const mirrorByVariationId = new Map(rows.map((row) => [row.id, row]));
  for (const { variationId, sku } of entries) {
    const row = mirrorByVariationId.get(variationId);
    if (!row || !row.present || row.sku !== sku) unsafe.add(sku);
  }
  return unsafe;
}
