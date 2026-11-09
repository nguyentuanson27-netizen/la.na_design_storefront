import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { readDynamicFeedbackContent } from "@/commerce/feedback-repository";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { LOCALES, LOCALE_LANGUAGE_TAG, DEFAULT_LOCALE, localizeHref } from "@/i18n/locale";
import { readSearchExposure } from "@/seo/search-exposure";
import {
  createSearchSitemapRepository,
  listStaticCanonicalPaths,
  MAX_SITEMAP_URLS,
} from "@/seo/search-sitemap-repository";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const exposure = readSearchExposure();

  if (!exposure.indexingEnabled) {
    return [];
  }

  const dynamicPaths = await createSearchSitemapRepository(prisma).listCanonicalPaths({
    shopId: readPancakeShopId(),
  });

  const feedbackContent = await readDynamicFeedbackContent();
  const staticPaths = listStaticCanonicalPaths({
    feedbackPublished: feedbackContent !== null,
  });

  const paths = [...staticPaths, ...dynamicPaths];
  const urlFor = (pathname: string, locale: (typeof LOCALES)[number]) =>
    new URL(localizeHref(pathname, locale), exposure.origin).href;

  // Every page is listed once per language, each listing naming all of its twins (and itself), as
  // Google asks. Past the single document's limit only the default language is listed, still with
  // its alternates -- a sitemap that is too long is a 500, which is worse than a shorter one.
  const languages = paths.length * LOCALES.length <= MAX_SITEMAP_URLS ? LOCALES : [DEFAULT_LOCALE];
  return languages.flatMap((locale) =>
    paths.map((pathname) => ({
      url: urlFor(pathname, locale),
      alternates: {
        languages: Object.fromEntries(
          LOCALES.map((candidate) => [LOCALE_LANGUAGE_TAG[candidate], urlFor(pathname, candidate)]),
        ),
      },
    })),
  );
}
