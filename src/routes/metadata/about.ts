import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { PUBLIC_BRAND_POSITIONING } from "@/content/public-brand-facts";

import { buildEvergreenPageMetadata, type StaticPageMetadataProps } from "./static-page.ts";

/** The About page's metadata. The description is the approved positioning sentence, not prose. */

export type AboutMetadataProps = StaticPageMetadataProps;

export async function buildAboutMetadata(props: AboutMetadataProps): Promise<Metadata> {
  return buildEvergreenPageMetadata({
    props,
    pathname: "/about",
    title: `Về ${BRAND.identity.name}`,
    description: PUBLIC_BRAND_POSITIONING,
  });
}
