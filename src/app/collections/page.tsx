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
          {data.collections.map((collection, index) => (
            <article
              key={collection.slug}
              className="group relative aspect-[16/9] overflow-hidden rounded-2xl border border-[#2A1810]/10 bg-[#2A1810] shadow-md transition-shadow duration-300 hover:shadow-xl"
            >
              {collection.heroImageUrl ? (
                <Image
                  src={collection.heroImageUrl}
                  alt={collection.title}
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  priority={index < 2}
                />
              ) : (
                <div className="absolute inset-0 bg-[#2A1810]" />
              )}
              {/* Subtle bottom-only scrim (covers bottom 50%), preserving 100% natural brightness for the upper photo */}
              <div
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 via-black/20 to-transparent transition-opacity duration-300 group-hover:from-black/75"
              />
              <div className="relative z-10 flex h-full flex-col justify-end p-6 sm:p-8 lg:p-10">
                <h2 className="max-w-xl font-serif text-2xl font-normal leading-tight text-[#FAF7F2] drop-shadow-md sm:text-3xl lg:text-4xl">
                  {collection.title}
                </h2>
                <div className="mt-4 sm:mt-6">
                  <Link
                    href={`/collections/${collection.slug}`}
                    className="collection-card-cta inline-flex min-h-11 items-center gap-2 rounded-full border border-white/80 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider backdrop-blur-md transition-all duration-300 hover:border-white"
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
