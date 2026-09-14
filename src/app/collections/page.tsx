import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { BRAND } from "@/brand";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { prisma } from "@/db/prisma";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type CollectionsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  searchParams,
}: CollectionsPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/collections",
    searchParams: await searchParams,
    title: "Bộ sưu tập",
    description: `Khám phá các bộ sưu tập từ ${BRAND.identity.name}.`,
  });
}

const repository = createCollectionDefinitionRepository(prisma);

export default async function CollectionsPage() {
  await connection();
  const publishedCollections = await repository.listPublished(50);

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">{BRAND.identity.name} / Bộ sưu tập</p>
      <h1 className="mt-4 max-w-6xl break-words text-[clamp(2.5rem,8vw,7rem)] font-semibold leading-[0.88] tracking-[-0.05em]">
        BỘ SƯU TẬP
      </h1>
      {publishedCollections.length > 0 ? (
        <div className="mt-12 grid gap-px border border-black/20 bg-black/20 md:grid-cols-2">
          {publishedCollections.map((collection) => (
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
                <Link
                  className="text-link"
                  href={`/collections/${collection.slug}`}
                >
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
