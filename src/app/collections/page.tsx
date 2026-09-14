import Link from "next/link";

import { BRAND } from "@/brand";
import { loadCollectionsRoute, type CollectionsRouteData } from "@/routes/collections";
import { createStorefrontRoute } from "@/routes/factory";
import { buildCollectionsMetadata } from "@/routes/metadata/collections";

/** Markup only. The published collections live in `@/routes/collections`. */

type CollectionsRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

function render(data: CollectionsRouteData) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">{BRAND.identity.name} / Bộ sưu tập</p>
      <h1 className="mt-4 max-w-6xl break-words text-[clamp(2.5rem,8vw,7rem)] font-semibold leading-[0.88] tracking-[-0.05em]">
        BỘ SƯU TẬP
      </h1>
      {data.collections.length > 0 ? (
        <div className="mt-12 grid gap-px border border-black/20 bg-black/20 md:grid-cols-2">
          {data.collections.map((collection) => (
            <article
              key={collection.slug}
              className="flex min-h-72 flex-col justify-between bg-[var(--paper)] p-8 md:p-12"
            >
              <div>
                <p className="eyebrow">Bộ sưu tập</p>
                <h2 className="mt-4 max-w-md break-words font-serif text-3xl leading-tight md:text-5xl">
                  {collection.title}
                </h2>
                {collection.description ? (
                  <p className="mt-4 max-w-lg break-words text-sm leading-6 text-black/65">
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
        <section
          aria-labelledby="collections-empty-title"
          className="ui-state ui-state--empty mt-12"
          data-ui-state="empty"
        >
          <p className="eyebrow">Bộ sưu tập hiện tại</p>
          <h2 id="collections-empty-title" className="ui-state__title">
            Các bộ sưu tập đang được chuẩn bị.
          </h2>
          <p className="ui-state__copy">
            Bộ sưu tập sẽ xuất hiện tại đây khi sẵn sàng.
          </p>
        </section>
      )}
    </div>
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
