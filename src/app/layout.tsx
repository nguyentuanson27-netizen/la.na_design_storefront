import type { Metadata } from "next";
import type { ReactNode } from "react";

import { buildRootLayoutMetadata } from "@/routes/metadata/root";
import { loadSiteChrome, SiteChrome } from "@/routes/site-chrome";

/**
 * The root layout, holding the same boundary as every other file under `src/app` (Task 36).
 *
 * What it used to do itself -- read the search exposure, build the site JSON-LD, mount the tracking
 * bootstrap, the masthead, the footer and the Meta pixel -- now happens in `@/routes/site-chrome`,
 * which owns the order of those concerns, and in the brand components it renders. This file is
 * wiring, which is what a page-layer module is allowed to be.
 */

export async function generateMetadata(): Promise<Metadata> {
  return buildRootLayoutMetadata();
}

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <SiteChrome model={await loadSiteChrome()}>{children}</SiteChrome>;
}
