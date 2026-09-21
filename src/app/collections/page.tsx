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
        <div className="mt-8 grid gap-px border border-[#3B2219]/15 bg-[#3B2219]/15 md:grid-cols-2">
          {data.collections.map((collection) => (
            <article
              key={collection.slug}
              className="flex min-h-72 flex-col justify-between bg-[var(--paper)] p-8 md:p-12"
            >
              <div>
                <p className="eyebrow text-[#70584B]">Bộ sưu tập</p>
                <h2 className="mt-4 max-w-md break-words font-serif text-3xl font-normal leading-tight text-[#2A1810] md:text-4xl">
                  {collection.title}
                </h2>
                {collection.description ? (
                  <p className="mt-4 max-w-lg break-words text-sm leading-6 text-[#3B2219]/70">
                    {collection.description}
                  </p>
                ) : null}
              </div>
              <div className="mt-8">
                <Link className="text-link" href={`/collections/${collection.slug}`}>
                  Khám phá bộ sưu tập ↗
                </Link>
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
