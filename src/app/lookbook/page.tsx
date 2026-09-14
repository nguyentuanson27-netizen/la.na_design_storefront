import Image from "next/image";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import {
  listConfiguredStorefrontProducts,
  resolveStorefrontPromotionForProducts,
} from "@/commerce/storefront-catalog-runtime";
import { BRAND } from "@/brand";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { StorefrontProductCard } from "@/components/commerce/storefront-product-card";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { PancakeConfigError } from "@/integrations/pancake/config";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type LookbookPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  searchParams,
}: LookbookPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/lookbook",
    searchParams: await searchParams,
    title: "Lookbook",
    description: `${BRAND.identity.name} editorial and styling stories for the city uniform.`,
  });
}

const tones = ["stone", "ink", "olive", "sand"] as const;

async function loadLookbookProducts(now: Date) {
  try {
    const products = await listConfiguredStorefrontProducts(4);
    const promotion = await resolveStorefrontPromotionForProducts({ products, now });
    return { products, ...promotion };
  } catch (error) {
    if (error instanceof PancakeConfigError) {
      return { products: [], pricingRule: undefined, refreshAfterMs: 60_000 };
    }
    throw error;
  }
}

export default async function LookbookPage() {
  await connection();
  const requestNow = new Date();
  const { products: featuredProducts, pricingRule, refreshAfterMs } = await loadLookbookProducts(requestNow);
  const productsWithMedia = featuredProducts.filter((p) => p.media?.primary);
  const listTracking = buildProductListTracking({
    products: featuredProducts,
    list: { listId: "lookbook-edit", listName: "Lookbook edit" },
    pricingRule,
  });
  const chapter1Product = productsWithMedia[0];
  const chapter1Image = chapter1Product?.media?.primary ?? null;
  const chapter2Product = productsWithMedia[1] ?? productsWithMedia[0];
  const chapter2Image = chapter2Product?.media?.primary ?? null;

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-16 md:py-24">
      <StorefrontPromotionRefresher refreshAfterMs={refreshAfterMs} />
      <header className="border-b border-black/20 pb-12 md:pb-16">
        <p className="eyebrow">Editorial / 02 · Permanent Edition</p>
        <h1 className="mt-4 max-w-6xl text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
          CITY UNIFORM
        </h1>
        <div className="mt-10 grid gap-8 md:grid-cols-2 md:items-end">
          <p className="max-w-xl font-serif text-2xl leading-snug md:text-4xl">
            A study in quiet utility.
          </p>
          <p className="max-w-lg text-sm leading-6 text-black/65 md:justify-self-end">
            Practical layers and measured proportions for moving through the city with ease.
          </p>
        </div>
      </header>

      <section className="grid border-b border-black/20 md:grid-cols-[1.35fr_0.65fr]" aria-labelledby="morning-transit-title">
        {chapter1Image ? (
          <div className="lookbook-panel relative min-h-[62vh] overflow-hidden md:min-h-[760px]">
            <Image
              src={chapter1Image.url}
              alt={chapter1Image.alt || chapter1Product?.name || `${BRAND.identity.name} Lookbook Chapter 1`}
              fill
              sizes="(min-width: 768px) 65vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : (
          <div
            className="lookbook-panel relative min-h-[62vh] overflow-hidden bg-[var(--stone)] md:min-h-[760px]"
            aria-hidden="true"
          />
        )}
        <div className="flex flex-col justify-end py-12 md:px-10 md:py-16">
          <p className="eyebrow">Chapter / 01 · 07:40</p>
          <h2 id="morning-transit-title" className="mt-4 font-serif text-[clamp(2.8rem,6vw,6rem)] leading-[0.9] tracking-[-0.045em]">
            MORNING / TRANSIT
          </h2>
          <p className="mt-6 max-w-md font-serif text-xl leading-relaxed text-black/75 md:text-2xl">
            Structured layering and clean proportions for morning movement and daylong wear.
          </p>
        </div>
      </section>

      <section className="grid border-b border-black/20 md:grid-cols-[0.65fr_1.35fr]" aria-labelledby="late-return-title">
        <div className="flex flex-col justify-end py-12 md:px-10 md:py-16">
          <p className="eyebrow">Chapter / 02 · 21:15</p>
          <h2 id="late-return-title" className="mt-4 font-serif text-[clamp(2.8rem,6vw,6rem)] leading-[0.9] tracking-[-0.045em]">
            LATE / RETURN
          </h2>
          <p className="mt-6 max-w-md font-serif text-xl leading-relaxed text-black/75 md:text-2xl">
            The uniform transitions into evening: relaxed silhouettes and deliberate structure.
          </p>
        </div>
        {chapter2Image ? (
          <div className="lookbook-panel relative min-h-[62vh] overflow-hidden bg-[var(--olive)] md:min-h-[760px]">
            <Image
              src={chapter2Image.url}
              alt={chapter2Image.alt || chapter2Product?.name || `${BRAND.identity.name} Lookbook Chapter 2`}
              fill
              sizes="(min-width: 768px) 65vw, 100vw"
              className="object-cover"
            />
          </div>
        ) : (
          <div
            className="lookbook-panel relative min-h-[62vh] overflow-hidden bg-[var(--olive)] md:min-h-[760px]"
            aria-hidden="true"
          />
        )}
      </section>

      {featuredProducts.length > 0 ? (
        <section className="border-b border-black/20 py-16 md:py-24" aria-labelledby="featured-pieces-title">
          <div className="section-heading-row mb-10">
            <div>
              <p className="eyebrow">Lookbook edit</p>
              <h2 id="featured-pieces-title" className="mt-2 text-xl font-semibold uppercase tracking-[0.08em]">
                Featured pieces
              </h2>
            </div>
            <Link className="text-link" href="/shop">
              Shop collection ↗
            </Link>
          </div>
          <CommerceEventReporter event={listTracking.listEvent} />
          <div className="product-grid">
            {featuredProducts.map((product, index) => (
              <StorefrontProductCard
                key={product.id}
                slug={product.slug}
                name={product.name}
                media={product.media}
                variants={product.variants}
                pricingRule={pricingRule}
                selectEvent={listTracking.selectEventBySlug.get(product.slug) ?? null}
                tone={tones[index % tones.length]!}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid gap-8 py-16 md:grid-cols-[1fr_auto] md:items-end md:py-24" aria-labelledby="lookbook-close-title">
        <div>
          <p className="eyebrow">Field notes</p>
          <h2 id="lookbook-close-title" className="mt-4 max-w-4xl font-serif text-[clamp(2.5rem,5vw,5.5rem)] leading-[0.92] tracking-[-0.04em]">
            Built for repetition, not a single occasion.
          </h2>
        </div>
        <Link className="text-link md:mb-2" href="/shop">
          Shop the current edit ↗
        </Link>
      </section>
    </div>
  );
}
