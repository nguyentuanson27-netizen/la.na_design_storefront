import type { ReactNode } from "react";

import { connection } from "next/server";

import { FacebookPixel } from "@/components/analytics/facebook-pixel";
import { TrackingBootstrap } from "@/components/analytics/tracking-bootstrap";
import { TrackingPageView } from "@/components/analytics/tracking-page-view";
import { SiteDocument } from "@/components/brand/site-document";
import { SiteFooter } from "@/components/brand/site-footer";
import { SiteMasthead } from "@/components/brand/site-masthead";
import {
  buildSiteChromeContent,
  type SiteChromeContent,
} from "@/components/headless/site-chrome-model";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildSiteStructuredData, serializeJsonLd } from "@/seo/structured-data";

import type { JsonLdEntity } from "./core.tsx";

/**
 * The site chrome every route renders inside.
 *
 * The root layout is not a storefront route -- it has no manifest entry, no view model of its own
 * and no metadata builder shaped like a route's -- but it has the same problem routes have: it
 * reads request state, it mounts analytics, and it publishes JSON-LD. Before Task 36 it did all
 * three itself, which is why it was the one page-layer file exempt from the boundary.
 *
 * So it gets the same shape: a loader here owns the reads, brand components own the presentation,
 * and this shell places the concerns that must not vary. `src/app/layout.tsx` is left with wiring
 * and holds the boundary like every other file under `src/app`.
 */

export type SiteChromeModel = Readonly<{
  /**
   * Site-level JSON-LD. A list rather than one document, matching `RoutePayload.structuredData`, so
   * the shell serialises it the same way routes are serialised: one `<script>` per document.
   */
  structuredData: readonly JsonLdEntity[];
  /**
   * What the masthead and footer render. Derived in `@/components/headless`, because the brand
   * layer takes props and does not reach into `@/commerce/*` (spec 06).
   */
  content: SiteChromeContent;
}>;

import { readConfiguredCategoryMegaMedia } from "@/commerce/storefront-catalog-runtime";

/**
 * The chrome's loader. `connection()` keeps the deployment's origin a request-time read rather than
 * a build-time constant, exactly as it was while this lived in the layout.
 */
export async function loadSiteChrome(): Promise<SiteChromeModel> {
  await connection();
  const [exposure, megaMedia] = await Promise.all([
    Promise.resolve(readSearchExposure()),
    readConfiguredCategoryMegaMedia(),
  ]);

  return {
    structuredData: [buildSiteStructuredData({ origin: exposure.origin })],
    content: buildSiteChromeContent(megaMedia),
  };
}

/**
 * The one place the chrome is assembled.
 *
 * Everything here is unconditional, for the reason `StorefrontRoute` gives: the tracking bootstrap,
 * the site JSON-LD, the canonical page view and the Meta pixel are exactly what a redraw forgets.
 * The brand layer supplies the document, the masthead and the footer -- what a brand should decide --
 * and cannot reach the order of the rest, because it never sees it.
 *
 * The page landmark is placed here rather than in a brand component because it is what the header's
 * skip link targets and what every page relies on not to repeat.
 */
export function SiteChrome({
  model,
  children,
}: Readonly<{ model: SiteChromeModel; children: ReactNode }>) {
  return (
    <SiteDocument>
      <TrackingBootstrap />
      {model.structuredData.map((document, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(document) }}
        />
      ))}
      <SiteMasthead promotion={model.content.promotion} header={model.content.header} />
      <main id="main-content">{children}</main>
      <SiteFooter model={model.content.footer} />
      <TrackingPageView />
      <FacebookPixel />
    </SiteDocument>
  );
}
