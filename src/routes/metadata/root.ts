import type { Metadata } from "next";
import { connection } from "next/server";

import { localizeMetadata } from "@/i18n/metadata";
import { getI18n } from "@/i18n/server";
import { buildRootMetadata } from "@/seo/root-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/**
 * The metadata every route inherits.
 *
 * It is not a route's builder -- the root layout has no manifest entry and no props -- but it is
 * here for the same reason theirs are: `src/app` may not read `@/seo`, so the read and the
 * `connection()` that keeps it request-time belong on this side of the boundary.
 */
export async function buildRootLayoutMetadata(): Promise<Metadata> {
  await connection();

  const { locale, t } = await getI18n();
  return localizeMetadata(buildRootMetadata(readSearchExposure()), locale, t);
}
