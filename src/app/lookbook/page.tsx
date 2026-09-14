import Image from "next/image";
import Link from "next/link";

import { BRAND } from "@/brand";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import type { EditorialPanel } from "@/routes/editorial-panels";
import { createStorefrontRoute } from "@/routes/factory";
import { loadLookbookRoute, type LookbookRouteData, type LookbookRouteProps } from "@/routes/lookbook";
import { buildLookbookMetadata } from "@/routes/metadata/lookbook";

/** Markup only. The edit and its two chapter photographs live in `@/routes/lookbook`. */

const tones: readonly ProductCardTone[] = ["stone", "ink", "olive", "sand"];

function ChapterPanel({
  panel,
  className,
  fallbackAlt,
}: Readonly<{ panel: EditorialPanel; className: string; fallbackAlt: string }>) {
  // A chapter with no trusted photography keeps its shape and is hidden from assistive technology,
  // rather than announcing an image that is not there.
  if (!panel) return <div className={className} aria-hidden="true" />;

  return (
    <div className={className}>
      <Image
        src={panel.image.url}
        alt={panel.image.alt || panel.productName || fallbackAlt}
        fill
        sizes="(min-width: 768px) 65vw, 100vw"
        className="object-cover"
      />
    </div>
  );
}

function render(data: LookbookRouteData) {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-16 md:py-24">
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
        <ChapterPanel
          panel={data.chapterOne}
          className="lookbook-panel relative min-h-[62vh] overflow-hidden bg-[var(--stone)] md:min-h-[760px]"
          fallbackAlt={`${BRAND.identity.name} Lookbook Chapter 1`}
        />
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
        <ChapterPanel
          panel={data.chapterTwo}
          className="lookbook-panel relative min-h-[62vh] overflow-hidden bg-[var(--olive)] md:min-h-[760px]"
          fallbackAlt={`${BRAND.identity.name} Lookbook Chapter 2`}
        />
      </section>

      {data.cards.length > 0 ? (
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
          <div className="product-grid">
            {data.cards.map((card, index) => (
              <ProductCard key={card.id} model={card.model} tone={tones[index % tones.length]!} />
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

const route = createStorefrontRoute<LookbookRouteProps, LookbookRouteData>({
  load: loadLookbookRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildLookbookMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
