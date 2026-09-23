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
          {data.collections.map((collection) =>
            collection.heroImageUrl ? (
              <article
                key={collection.slug}
                className="group relative aspect-[16/9] overflow-hidden rounded-2xl border border-[#2A1810]/10 bg-[#FAF7F2] shadow-sm transition-all duration-500 hover:shadow-xl"
              >
                <div
                  data-collection-card-media=""
                  className="absolute inset-0"
                >
                  <Image
                    src={collection.heroImageUrl}
                    alt=""
                    fill
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  />
                </div>

                {/* Accessible title for screen readers / WCAG */}
                <h2 className="sr-only">{collection.title}</h2>

                {/* Gentle bottom-only vignette to anchor the artistic CTA */}
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/35 via-black/10 to-transparent transition-opacity duration-300 group-hover:from-black/45"
                />

                <div className="relative z-10 flex h-full flex-col justify-end p-5 sm:p-7 lg:p-8">
                  <div>
                    <Link
                      href={`/collections/${collection.slug}`}
                      className="collection-card-cta"
                    >
                      Khám phá bộ sưu tập ↗
                    </Link>
                  </div>
                </div>
              </article>
            ) : (
              <article
                key={collection.slug}
                className="group relative flex min-h-72 flex-col justify-between overflow-hidden rounded-2xl border border-[#2A1810]/10 bg-[var(--paper)] p-8 shadow-sm transition-shadow duration-300 hover:shadow-md md:p-10"
              >
                <div
                  data-collection-card-media=""
                  data-collection-card-fallback=""
                  aria-hidden="true"
                  className="hidden"
                />
                <div>
                  <h2 className="max-w-xl break-words font-serif text-2xl font-normal leading-tight text-[#2A1810] sm:text-3xl lg:text-4xl">
                    {collection.title}
                  </h2>
                </div>
                <div className="mt-8">
                  <Link
                    href={`/collections/${collection.slug}`}
                    className="collection-card-cta"
                  >
                    Khám phá bộ sưu tập ↗
                  </Link>
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
