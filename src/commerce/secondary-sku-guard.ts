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
