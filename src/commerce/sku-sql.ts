import { Prisma } from "../generated/prisma/client.ts";
import {
  SKU_ASCII_LOWER,
  SKU_ASCII_UPPER,
  SKU_TRIM_CHARACTERS,
} from "../integrations/pancake/sku.ts";

/**
 * The database-side twin of `normalizeSku()`: the same characters trimmed from both ends, the same
 * ASCII-only upper-casing, empty meaning NULL. `column` must be a text expression.
 */
export function normalizedSkuSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NULLIF(translate(btrim(${column}, ${SKU_TRIM_CHARACTERS}::text), ${SKU_ASCII_LOWER}::text, ${SKU_ASCII_UPPER}::text), '')`;
}
