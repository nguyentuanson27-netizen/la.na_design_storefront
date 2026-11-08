import Link from "@/components/brand/localized-link";

import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingShell,
  ListingViewBar,
} from "@/components/brand/listing-chrome";
import { ListingCollectionGrid, ListingCollectionImage } from "@/components/brand/listing-view";
import { loadCollectionsRoute, type CollectionsRouteData } from "@/routes/collections";
import { createStorefrontRoute, type RequestI18n } from "@/routes/factory";
import { buildCollectionsMetadata } from "@/routes/metadata/collections";

/**
 * Markup only. The published collections live in `@/routes/collections`.
 *
 * This is the aggregate collections landing page, not a product listing: it shares the chrome --
 * shell, breadcrumb, display H1, empty state -- and deliberately not the product grid,
 * filters or paging. Master spec §10 keeps it as an index, and there are no approved child
 * collections to pad it with.
 */

type CollectionsRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

type ListedCollection = CollectionsRouteData["collections"][number];

/**
 * Square, flat cards: the product grid, the gallery and the hero are all unrounded and unshadowed,
 * and a rounded, lifted card read as a different site. An odd last card on the two-column grid is
 * centred at one column's width instead of leaving the row's other half empty.
 */
const CARD_LAYOUT =
  "md:group-data-[view=large]/cgrid:last:odd:col-span-2 md:group-data-[view=large]/cgrid:last:odd:w-[calc(50%-0.75rem)] md:group-data-[view=large]/cgrid:last:odd:justify-self-center lg:group-data-[view=large]/cgrid:last:odd:w-[calc(50%-1rem)]";

/*
 * The centring above is for the two-across grid only. With a smaller photograph size there are
 * three or four columns, and an odd last card spanning two of them would be wrong, so the card
 * keeps it only in the large view (`group-data-[view=large]/cgrid`, set by `ListingCollectionGrid`).
 */

/**
 * The card's one link, in the homepage banner's vocabulary: an underlined small-caps "Khám phá",
 * not a filled button. Its hit area is stretched over the whole card (`globals.css`), so the
 * photograph that zooms on hover is also what a tap opens. The visible label is the same on every
 * card; the collection's name rides along for screen readers, so a link read out of context --
 * in a links list -- still says where it goes.
 */
function CollectionCardCta({
  collection,
  label,
  tone = "light",
}: Readonly<{ collection: ListedCollection; label: string; tone?: "light" | "ink" }>) {
  return (
    <Link
      href={`/collections/${collection.slug}`}
      className={tone === "ink" ? "collection-card-cta collection-card-cta--ink" : "collection-card-cta"}
    >
      {label}
      <span className="sr-only">: {collection.title}</span>
    </Link>
  );
}

function render(data: CollectionsRouteData, { t }: RequestI18n) {
  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Bộ sưu tập" }]} />
      <ListingHeader title={t("Bộ sưu tập")} />

      {data.collections.length > 0 ? (
        // On a phone the covers run edge to edge with the product grid's 2px seam, the way the
        // homepage stacks its collection banners; the shell's gutter would cost each 16:9 cover a
        // seventh of its height. From `md` they sit in the container, two across.
        <>
          <ListingViewBar className="mt-6 md:mt-8" totalCount={data.collections.length} countLabel="bộ sưu tập" rule={false} />
          <ListingCollectionGrid className="-mx-6 mt-3 gap-[2px] md:mx-0 md:gap-6 lg:gap-8">
            {data.collections.map((collection) =>
              collection.heroImageUrl ? (
                <article
                  key={collection.slug}
                  className={`group relative isolate aspect-[16/9] overflow-hidden bg-[var(--stone)] ${CARD_LAYOUT}`}
                >
                  {/* Behind the copy (`-z-10` inside the isolated card) rather than the copy lifted
                      over it, so the card -- not the copy box -- is what the CTA's stretched hit area
                      covers. */}
                  <div
                    data-collection-card-media=""
                    className="absolute inset-0 -z-10"
                  >
                    <ListingCollectionImage
                      src={collection.heroImageUrl}
                      alt=""
                      fill
                      className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                    />
                  </div>

                  {/* The cover photograph carries the collection's name (owner decision), so the title
                      is for screen readers only and is not printed a second time over it. */}
                  <h2 className="sr-only">{collection.title}</h2>

                  {/* Gentle bottom-only vignette under the light CTA */}
                  <div
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 -z-10 h-1/3 bg-gradient-to-t from-black/45 via-black/10 to-transparent transition-opacity duration-300 group-hover:from-black/55"
                  />

                  <div className="flex h-full flex-col items-center justify-end px-5 pb-2 sm:pb-5 lg:pb-6">
                    <CollectionCardCta collection={collection} label={t("Khám phá")} />
                  </div>
                </article>
              ) : (
                <article
                  key={collection.slug}
                  className={`group relative flex min-h-[56.25vw] flex-col justify-between overflow-hidden border-y border-[#2A1810]/10 bg-[var(--cream)] p-6 transition-colors duration-300 hover:bg-[var(--paper)] md:min-h-72 md:border md:p-10 ${CARD_LAYOUT}`}
                >
                  <div
                    data-collection-card-media=""
                    data-collection-card-fallback=""
                    aria-hidden="true"
                    className="hidden"
                  />
                  <div>
                    <h2 className="max-w-xl break-words font-display text-2xl font-normal leading-tight text-[#2A1810] sm:text-3xl lg:text-4xl">
                      {collection.title}
                    </h2>
                  </div>
                  <div className="mt-6 md:mt-8">
                    <CollectionCardCta collection={collection} label={t("Khám phá")} tone="ink" />
                  </div>
                </article>
              ),
            )}
          </ListingCollectionGrid>
        </>
      ) : (
        <ListingEmptyState
          titleId="collections-empty-title"
          eyebrow={t("Bộ sưu tập hiện tại")}
          title={t("Các bộ sưu tập đang được chuẩn bị.")}
          copy={t("Bộ sưu tập sẽ xuất hiện tại đây khi sẵn sàng.")}
        />
      )}
    </ListingShell>
  );
}

const route = createStorefrontRoute<CollectionsRouteProps, CollectionsRouteData>({
  load: loadCollectionsRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildCollectionsMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
