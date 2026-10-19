import Image from "next/image";
import Link from "next/link";

import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { loadCollectionsRoute, type CollectionsRouteData } from "@/routes/collections";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCollectionsMetadata } from "@/routes/metadata/collections";

/**
 * Markup only. The published collections live in `@/routes/collections`.
 *
 * This is the aggregate collections landing page, not a product listing: it shares the chrome --
 * shell, breadcrumb, eyebrow, serif H1, empty state -- and deliberately not the product grid,
 * filters or paging. Master spec §10 keeps it as an index, and there are no approved child
 * collections to pad it with.
 */

type CollectionsRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

type ListedCollection = CollectionsRouteData["collections"][number];

/**
 * The card's one link, in the homepage banner's vocabulary: an underlined small-caps "Khám phá",
 * not a filled button. Its hit area is stretched over the whole card (`globals.css`), so the
 * photograph that zooms on hover is also what a tap opens. The visible label is the same on every
 * card; the collection's name rides along for screen readers, so a link read out of context --
 * in a links list -- still says where it goes.
 */
function CollectionCardCta({
  collection,
  tone = "light",
}: Readonly<{ collection: ListedCollection; tone?: "light" | "ink" }>) {
  return (
    <Link
      href={`/collections/${collection.slug}`}
      className={tone === "ink" ? "collection-card-cta collection-card-cta--ink" : "collection-card-cta"}
    >
      Khám phá
      <span className="sr-only">: {collection.title}</span>
    </Link>
  );
}

function render(data: CollectionsRouteData) {
  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Bộ sưu tập" }]} />
      <ListingHeader eyebrow="Tuyển chọn" title="Bộ sưu tập" />

      {data.collections.length > 0 ? (
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2 lg:gap-8">
          {data.collections.map((collection) =>
            collection.heroImageUrl ? (
              <article
                key={collection.slug}
                className="group relative isolate aspect-[16/9] overflow-hidden rounded-2xl border border-[#2A1810]/10 bg-[#FAF7F2] shadow-sm transition-all duration-500 hover:shadow-xl"
              >
                {/* Behind the copy (`-z-10` inside the isolated card) rather than the copy lifted
                    over it, so the card -- not the copy box -- is what the CTA's stretched hit area
                    covers. */}
                <div
                  data-collection-card-media=""
                  className="absolute inset-0 -z-10"
                >
                  <Image
                    src={collection.heroImageUrl}
                    alt=""
                    fill
                    sizes="(min-width: 768px) 50vw, 100vw"
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
                  <CollectionCardCta collection={collection} />
                </div>
              </article>
            ) : (
              <article
                key={collection.slug}
                className="group relative flex min-h-48 flex-col justify-between overflow-hidden rounded-2xl border border-[#2A1810]/10 bg-[var(--paper)] p-6 shadow-sm transition-shadow duration-300 hover:shadow-md md:min-h-72 md:p-10"
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
                  <CollectionCardCta collection={collection} tone="ink" />
                </div>
              </article>
            ),
          )}
        </div>
      ) : (
        <ListingEmptyState
          titleId="collections-empty-title"
          eyebrow="Bộ sưu tập hiện tại"
          title="Các bộ sưu tập đang được chuẩn bị."
          copy="Bộ sưu tập sẽ xuất hiện tại đây khi sẵn sàng."
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
