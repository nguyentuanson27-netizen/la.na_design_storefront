import Image from "next/image";
import Link from "next/link";

import type { HomeCategoryDiscoverySection } from "@/routes/home-model";

/**
 * YOUR NEXT FAVOURITE (spec §7.4): the four canonical categories as editorial image blocks, four
 * across on desktop and 2 × 2 on a phone.
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
      <div className="section-heading-row">
        <h2 id="home-category-discovery-title">{section.title}</h2>
      </div>
      {section.description ? (
        <p className="category-discovery__description">{section.description}</p>
      ) : null}
      <ul className="category-discovery__grid">
        {section.tiles.map((tile) => (
          <li key={tile.key}>
            <Link className="category-discovery__tile" href={tile.href}>
              <span className="category-discovery__media">
                <Image
                  src={tile.imageUrl}
                  alt=""
                  fill
                  sizes="(min-width: 901px) 25vw, 50vw"
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
