import Link from "next/link";

import { BRAND } from "@/brand";
import { CategoryDiscovery } from "@/components/brand/category-discovery";
import { CollectionPromoRow } from "@/components/brand/collection-promo-row";
import { FeedbackRail } from "@/components/brand/feedback-gallery";
import { BrandHeroSlider } from "@/components/brand/hero-slider";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { createStorefrontRoute } from "@/routes/factory";
import { loadHomeRoute, type HomeRouteData, type HomeRouteProps } from "@/routes/home";
import { buildHomeMetadata } from "@/routes/metadata/home";

/**
 * The homepage, in the fixed order `docs/specs/homepage-editorial-refresh.md` §7 approves:
 *
 *   Hero → SPECIAL DEALS → Collection promo row A → YOUR NEXT FAVOURITE
 *        → Collection promo row B → Feedback → Footer
 *
 * The hero is unchanged. Everything after it is fail-closed: the loader hands this page `null` for a
 * section whose data is pending, incomplete or inconsistent, and the page renders nothing for it --
 * never a partial grid, a placeholder image or a link to a collection the public route would 404.
 * Markup only; every decision lives in `@/routes/home-model`.
 */

const tones: readonly ProductCardTone[] = ["stone", "ink", "olive", "sand"];

function render(data: HomeRouteData) {
  const { specialDeals, categoryDiscovery, feedback } = data;

  return (
    <>
      {/* The hero carries image and CTA only (§17), so the page's one h1 cannot live inside it.
          It reads the approved homepage title rather than restating it, and is available to
          assistive technology without putting a heading over the campaign art. */}
      <h1 className="sr-only" data-homepage-root="">{BRAND.identity.homeTitle}</h1>

      <BrandHeroSlider slides={data.heroSlides} />

      {specialDeals ? (
        <section
          className="product-section special-deals"
          aria-labelledby="home-special-deals-title"
          data-homepage-region="special-deals"
        >
          <div className="section-heading-row">
            <h2 id="home-special-deals-title">{specialDeals.title}</h2>
          </div>
          {specialDeals.supportingCopy ? (
            <p className="special-deals__copy">{specialDeals.supportingCopy}</p>
          ) : null}
          <div className="product-grid">
            {specialDeals.cards.map((card, index) => (
              <ProductCard key={card.id} model={card.model} tone={tones[index % tones.length]!} />
            ))}
          </div>
          <p className="home-more">
            <Link href={specialDeals.href}>
              {specialDeals.ctaLabel}
              <span className="sr-only">: {specialDeals.collectionTitle}</span>
            </Link>
          </p>
        </section>
      ) : null}

      {data.promoRowA ? <CollectionPromoRow row={data.promoRowA} region="promo-a" /> : null}

      {categoryDiscovery ? <CategoryDiscovery section={categoryDiscovery} /> : null}

      {data.promoRowB ? <CollectionPromoRow row={data.promoRowB} region="promo-b" /> : null}

      {feedback ? (
        <FeedbackRail
          title={feedback.title}
          ctaLabel={feedback.ctaLabel}
          href={feedback.href}
          images={feedback.images}
        />
      ) : null}
    </>
  );
}

const route = createStorefrontRoute<HomeRouteProps, HomeRouteData>({
  load: loadHomeRoute,
  metadata: (props) => buildHomeMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
