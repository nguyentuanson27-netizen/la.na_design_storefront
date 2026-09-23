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

function render(data: CollectionsRouteData) {
  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Bộ sưu tập" }]} />
      <ListingHeader eyebrow="Tuyển chọn" title="Bộ sưu tập" />

      {data.collections.length > 0 ? (
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2 lg:gap-8">
          {data.collections.map((collection) => (
            <article
              key={collection.slug}
              className="group rounded-2xl border border-[#2A1810]/10 bg-[#2A1810] shadow-md transition-shadow duration-300 hover:shadow-xl"
            >
              <div
                data-collection-card-media=""
                className="relative aspect-[16/9] overflow-hidden rounded-t-2xl bg-[#2A1810]"
              >
                {collection.heroImageUrl ? (
                  <Image
                    src={collection.heroImageUrl}
                    alt=""
                    fill
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  />
                ) : (
                  <div
                    data-collection-card-fallback=""
                    aria-hidden="true"
                    className="absolute inset-0 bg-[#2A1810]"
                  />
                )}
              </div>

              {/*
               * The media stays a real 16:9 box. Content overlaps its lower edge for the editorial
               * treatment, but remains in normal flow so any valid collection title can grow the
               * card instead of being clipped by a fixed-ratio overflow container.
               */}
              <div className="relative z-10 -mt-24 rounded-b-2xl bg-gradient-to-t from-[#2A1810] via-[#2A1810]/95 to-[#2A1810]/70 px-6 pb-6 pt-16 sm:-mt-28 sm:px-8 sm:pb-8 sm:pt-20 lg:px-10 lg:pb-10">
                <h2 className="max-w-xl break-words font-serif text-2xl font-normal leading-tight text-[#FAF7F2] drop-shadow-md sm:text-3xl lg:text-4xl">
                  {collection.title}
                </h2>
                <div className="mt-4 sm:mt-6">
                  <Link
                    href={`/collections/${collection.slug}`}
                    className="collection-card-cta"
                  >
                    Khám phá bộ sưu tập ↗
                  </Link>
                </div>
              </div>
            </article>
          ))}
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
