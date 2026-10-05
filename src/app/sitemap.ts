import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { readDynamicFeedbackContent } from "@/commerce/feedback-repository";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { readSearchExposure } from "@/seo/search-exposure";
import {
  createSearchSitemapRepository,
  listStaticCanonicalPaths,
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

  return [...staticPaths, ...dynamicPaths].map((pathname) => ({
    url: new URL(pathname, exposure.origin).href,
  }));
}
