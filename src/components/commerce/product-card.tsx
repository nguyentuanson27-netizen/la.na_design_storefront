import Image from "next/image";
import Link from "next/link";

type ProductCardProps = {
  name: string;
  href: string;
  price: string;
  tone: "stone" | "olive" | "ink" | "sand";
  badge?: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
};

export function ProductCard({
  name,
  href,
  price,
  tone,
  badge,
  imageUrl,
  imageAlt,
}: ProductCardProps) {
  return (
    <article className="product-card group">
      <Link href={href} className="product-visual-link" aria-label={`${name} — ${price}`}>
        <div
          className={`product-visual product-visual--${tone} relative aspect-[2/3] overflow-hidden`}
          aria-hidden={imageUrl ? undefined : "true"}
        >
          {badge ? <span className="product-badge z-10">{badge}</span> : null}
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={imageAlt || name}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              className="object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <span className="garment-silhouette" />
          )}
        </div>
      </Link>
      <div className="product-meta">
        <h3>
          <Link href={href}>{name}</Link>
        </h3>
        <p>{price}</p>
      </div>
    </article>
  );
}
