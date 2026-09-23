import Image from "next/image";
import Link from "next/link";

import type { HomePromoRow } from "@/routes/home-model";

/**
 * One two-tile collection promo row (spec §7.3 / §7.5). Both rows render through this one component;
 * they differ only by config data.
 *
 * Markup only, and deliberately one anchor per tile: the CTA. What changes between breakpoints is
 * its hit area, not the element. On desktop the image is not a link and only the CTA is clickable;
 * on a phone the stylesheet stretches that same anchor over the whole tile (`::after`), so the full
 * tile is one tap target with one destination and nothing is nested inside a link.
 *
 * The visible title is the collection's canonical `CollectionDefinition.title`, resolved by the
 * loader. The CTA's accessible name carries that title as well, so a link read out of context still
 * says where it goes.
 */
export function CollectionPromoRow({
  row,
  region,
}: Readonly<{ row: HomePromoRow; region: "promo-a" | "promo-b" }>) {
  return (
    <div className="collection-promo-row" data-homepage-region={region}>
      {row.map((tile) => (
        <article className="collection-promo" key={tile.collectionSlug}>
          <div className="collection-promo__media">
            {/* Decorative: the collection title beside it names what the photograph shows. */}
            <Image
              src={tile.imageSrc}
              alt=""
              fill
              sizes="50vw"
              className="object-cover"
            />
          </div>
          <div className="collection-promo__copy">
            <h2 className="collection-promo__title">{tile.title}</h2>
            <Link className="collection-promo__cta" href={tile.href}>
              {tile.ctaLabel}
              <span className="sr-only">: {tile.title}</span>
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
