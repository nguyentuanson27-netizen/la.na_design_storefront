import Image from "next/image";
import Link from "next/link";

import { BRAND, HOME_SERVICE_FACTS } from "@/brand";
import { CATEGORY_NAVIGATION } from "@/brand/category.config";
import { BrandHeroSlider } from "@/components/brand/hero-slider";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import { createStorefrontRoute } from "@/routes/factory";
import { loadHomeRoute, type HomeRouteData, type HomeRouteProps } from "@/routes/home";
import { buildHomeMetadata } from "@/routes/metadata/home";
import type { HomeCard } from "@/routes/home-model";

/**
 * The homepage, in the fixed order master spec §16 approves:
 *
 *   Hero → Hàng mới về → Áo dài La.na Design → Featured → Category editorial
 *        → Service strip → Brand story → Footer
 *
 * Every block that depends on content an admin owns omits itself when that content is absent. That
 * is the rule the whole page is built around: an editorial block with no image renders nothing
 * rather than a grey rectangle, and an empty Featured section stays empty rather than borrowing new
 * arrivals, which §20 forbids in as many words.
 *
 * The collection rail keeps its own place and its `data-homepage-region` marker. §16 does not list
 * it, and §16 also says it stays hidden until a real child collection is approved -- which is what
 * its emptiness check already does, so it is kept rather than deleted out from under U2.
 */

const tones: readonly ProductCardTone[] = ["stone", "ink", "olive", "sand"];

const AO_DAI = CATEGORY_NAVIGATION.find((category) => category.key === "aoDai")!;
const SET_DO = CATEGORY_NAVIGATION.find((category) => category.key === "setDo")!;
const VAY_DAM = CATEGORY_NAVIGATION.find((category) => category.key === "vayDam")!;

function ProductGrid({ cards }: Readonly<{ cards: readonly HomeCard[] }>) {
  return (
    <div className="product-grid">
      {cards.map((card, index) => (
        <ProductCard key={card.id} model={card.model} tone={tones[index % tones.length]!} />
      ))}
    </div>
  );
}

/**
 * One category editorial block (§21).
 *
 * The clickable label is the category name itself, per §21 -- no invented `Khám phá` wrapper. The
 * image URL arrives already checked against the trusted-media contract in the loader, so this
 * component is only ever reached with a trusted URL; whether the section renders at all is decided
 * once, in `render`, because §21 fixes the section at exactly two blocks.
 */
function CategoryEditorial({
  category,
  imageUrl,
}: Readonly<{ category: { href: string; label: string }; imageUrl: string }>) {
  return (
    <Link className="category-editorial__block" href={category.href}>
      <span className="category-editorial__media">
        {/* Decorative: the label below is the link's accessible name, so alt text here would
            announce the category twice to a screen reader -- which is what Axe's
            `duplicate-img-label` rule reports. The photograph illustrates the name, it does not
            add a fact to it. */}
        <Image
          src={imageUrl}
          alt=""
          fill
          sizes="(min-width: 901px) 50vw, 100vw"
          className="object-cover"
        />
      </span>
      <span className="category-editorial__label">{category.label}</span>
    </Link>
  );
}

function render(data: HomeRouteData) {
  const { brandFacts, categoryHeroMedia } = data;
  const aoDaiImage = categoryHeroMedia.get(AO_DAI.key);
  const setDoImage = categoryHeroMedia.get(SET_DO.key);
  const vayDamImage = categoryHeroMedia.get(VAY_DAM.key);
  // §21 fixes this section at exactly two blocks, and the house rule forbids a placeholder to
  // stand in for a missing one. So it is both or neither: one untrusted or absent image closes the
  // whole section rather than publishing a half-width row nobody approved.
  const hasCategoryEditorial = setDoImage !== undefined && vayDamImage !== undefined;

  return (
    <>
      {/* The hero carries image and CTA only (§17), so the page's one h1 cannot live inside it.
          It reads the approved homepage title rather than restating it, and is available to
          assistive technology without putting a heading over the campaign art. */}
      <h1 className="sr-only" data-homepage-root="">{BRAND.identity.homeTitle}</h1>

      <BrandHeroSlider slides={data.heroSlides} />

      <section
        className="product-section"
        aria-labelledby="home-new-arrivals-title"
        data-homepage-region="new-arrivals"
      >
        {/* No `Xem tất cả` here. `/new-arrivals` is the drop announcement and carries no product
            listing on purpose -- `/shop` owns filtering and ordering -- so a CTA out of this grid
            would land a shopper who wants more products on a page with none. It can return when
            that route gains a listing, not before. */}
        <div className="section-heading-row">
          <h2 id="home-new-arrivals-title">Hàng mới về</h2>
        </div>
        {data.newArrivals.length > 0 ? (
          <ProductGrid cards={data.newArrivals} />
        ) : (
          <div className="ui-state ui-state--empty" data-ui-state="empty">
            <p className="ui-state__copy">
              Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để hiển thị trên website.
            </p>
          </div>
        )}
      </section>

      {/* §19: one large editorial image, the lead category's own name, and a direct link to each
          of its five subcategories. The block omits itself when no hero image is configured.

          §19 also asks for a short Vietnamese paragraph here, and it is deliberately absent. The
          master spec states that exact copy for this category is not yet owner-approved and must be
          drafted for review rather than invented, so this section publishes the category's real
          name and real destinations and waits for that copy. Writing a paragraph that reads like
          approved brand voice would be the one thing this page is not allowed to do. */}
      {aoDaiImage !== undefined ? (
        <section
          className="lead-editorial"
          aria-labelledby="home-lead-category-title"
          data-homepage-region="lead-category"
        >
          <div className="lead-editorial__media">
            <Image
              src={aoDaiImage}
              alt={AO_DAI.label}
              fill
              sizes="(min-width: 901px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="lead-editorial__copy">
            <h2 id="home-lead-category-title">
              {AO_DAI.label} {BRAND.identity.name}
            </h2>
            <nav aria-label={AO_DAI.label}>
              <ul className="lead-editorial__links">
                {(AO_DAI.children ?? []).map((child) => (
                  <li key={child.key}>
                    <Link className="text-link" href={child.href}>{child.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </section>
      ) : null}

      {/* §20: manual selection only. An empty table means an empty section -- never a fallback. */}
      {data.featured.length > 0 ? (
        <section
          className="product-section"
          aria-labelledby="home-featured-title"
          data-homepage-region="featured"
        >
          <div className="section-heading-row">
            <h2 id="home-featured-title">Sản phẩm nổi bật</h2>
          </div>
          <ProductGrid cards={data.featured} />
        </section>
      ) : null}

      {/* §21: exactly two blocks, 50/50 on desktop. Phụ kiện is deliberately not one of them. */}
      {hasCategoryEditorial ? (
        <section
          className="category-editorial"
          aria-labelledby="home-category-editorial-title"
          data-homepage-region="category-editorial"
        >
          <h2 className="sr-only" id="home-category-editorial-title">Danh mục nổi bật</h2>
          <CategoryEditorial category={SET_DO} imageUrl={setDoImage} />
          <CategoryEditorial category={VAY_DAM} imageUrl={vayDamImage} />
        </section>
      ) : null}

      {data.collections.length > 0 ? (
        <section
          className="category-strip"
          aria-labelledby="homepage-collections-title"
          data-homepage-region="collection-navigation"
        >
          <p className="eyebrow" id="homepage-collections-title">Mua theo bộ sưu tập</p>
          <nav className="category-links" aria-label="Bộ sưu tập nổi bật">
            {data.collections.map((collection) => (
              <Link key={collection.slug} href={`/collections/${collection.slug}`}>
                {collection.title}
              </Link>
            ))}
          </nav>
        </section>
      ) : null}

      {/* §22: three approved facts, stated as facts. Not a place to add a fourth promise. */}
      <section
        className="service-strip"
        aria-labelledby="home-service-title"
        data-homepage-region="service"
      >
        <h2 className="sr-only" id="home-service-title">Dịch vụ</h2>
        <ul>
          {HOME_SERVICE_FACTS.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      {/* §23: editorial image left, approved copy right, link to /about. The copy is quoted from
          Brand Config rather than written here, so no surface can reword it. */}
      <section
        className="brand-story"
        aria-labelledby="brand-facts-title"
        data-homepage-region="trust-support"
      >
        {data.storyPanel ? (
          <div className="brand-story__media">
            <Image
              src={data.storyPanel.image.url}
              alt={data.storyPanel.image.alt || data.storyPanel.productName || BRAND.identity.name}
              fill
              sizes="(min-width: 901px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : null}
        <div className="brand-story__copy">
          <h2 id="brand-facts-title">{brandFacts.brandName}</h2>
          <p className="font-serif text-2xl leading-snug md:text-3xl">
            {BRAND.identity.homeBrandStory}
          </p>
          <p className="mt-6">
            <Link className="text-link" href="/about">Về {BRAND.identity.name} ↗</Link>
          </p>
          <dl className="mt-8 space-y-5 text-sm leading-6">
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Thanh toán</dt>
              <dd className="mt-1 text-black/70">
                {brandFacts.paymentMethod} {brandFacts.checkoutAccount}
              </dd>
            </div>
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Vận chuyển</dt>
              <dd className="mt-1 text-black/70">
                {brandFacts.shipping.title}. {brandFacts.shipping.detail}
              </dd>
            </div>
            <div>
              <dt className="font-semibold uppercase tracking-[0.12em]">Xác nhận đơn hàng</dt>
              <dd className="mt-1 text-black/70">{brandFacts.serverVerification}</dd>
            </div>
          </dl>
          <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-3" aria-label="Hỗ trợ và khám phá">
            <Link className="text-link" href="/shop">Cửa hàng ↗</Link>
            <Link className="text-link" href="/collections">Bộ sưu tập ↗</Link>
            <Link className="text-link" href="/track-order">Tra cứu đơn ↗</Link>
          </nav>
        </div>
      </section>
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
