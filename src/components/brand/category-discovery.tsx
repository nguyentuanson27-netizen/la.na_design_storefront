import Image from "next/image";
import Link from "next/link";

import type { HomeCategoryDiscoverySection } from "@/routes/home-model";

/**
 * YOUR NEXT FAVOURITE (spec §7.4): the heading and its supporting line in a column on the left, the
 * four canonical categories as spaced image blocks on the right with their names centred beneath.
 * On a phone the heading stacks above a 2 × 2 grid.
 *
 * The loader only hands this component a section when all four trusted images resolved, so there
 * is no partial or image-less state to draw here. Each block is one link whose accessible name is
 * the category label; the photograph is decorative for the same reason.
 */
export function CategoryDiscovery({ section }: Readonly<{ section: HomeCategoryDiscoverySection }>) {
  return (
    <section
      className="category-discovery"
      aria-labelledby="home-category-discovery-title"
      data-homepage-region="category-discovery"
    >
      <div className="category-discovery__intro">
        <h2 id="home-category-discovery-title" className="category-discovery__title">
          {section.title}
        </h2>
        {section.description ? (
          <p className="category-discovery__description">{section.description}</p>
        ) : null}
      </div>
      <ul className="category-discovery__grid">
        {section.tiles.map((tile) => (
          <li key={tile.key}>
            <Link className="category-discovery__tile" href={tile.href}>
              <span className="category-discovery__media">
                <Image
                  src={tile.imageUrl}
                  alt=""
                  fill
                  sizes="(min-width: 901px) 18vw, 50vw"
                  className="object-cover"
                />
              </span>
              <span className="category-discovery__label">{tile.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
