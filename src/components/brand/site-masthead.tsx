import type { SiteHeaderModel, SitePromotionModel } from "@/components/headless/site-chrome-model";
import { SiteHeader } from "@/components/brand/site-header";

/**
 * The block pinned to the top of every page.
 *
 * Pinned together: the promotion and the nav stay on screen as one block while the page scrolls
 * under them. Sticky rather than fixed, so they still occupy layout space and nothing has to be
 * offset to sit below them.
 */
export function SiteMasthead({
  promotion,
  header,
}: Readonly<{
  promotion: SitePromotionModel;
  header?: SiteHeaderModel;
}>) {
  return (
    <div className="site-masthead">
      {/* The landmark keeps the short, stable name; the headline is the content it introduces. */}
      <aside aria-label={promotion.label} className="promotion-shell">
        {promotion.headline}
      </aside>
      <SiteHeader model={header} />
    </div>
  );
}
