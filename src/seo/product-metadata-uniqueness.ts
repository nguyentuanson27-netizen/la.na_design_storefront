import { BRAND } from "../brand/index.ts";
/**
 * W2a: the metadata uniqueness replacement contract.
 *
 * PDP titles and descriptions currently append the canonical slug and the `/shop/<slug>` path. That
 * copy reads poorly in a SERP, but it is doing real work: it is the only thing that keeps two PDPs
 * distinguishable when their published SEO copy — or their fallback copy — is identical. Nothing in
 * the schema makes `ProductContent.seoTitle`/`seoDescription` or `ProductMirror.name` unique.
 *
 * Removing the slug is therefore gated on evidence, not on taste. This module owns that evidence:
 * it builds the slug-free copy a replacement contract would produce and reports exactly which
 * products would stop being distinguishable under it. It deliberately does not change what the live
 * PDP emits; `buildStorefrontProductMetadata` stays the single metadata authority.
 *
 * The discriminators the audit warns against are not used here. Colour, collection membership and
 * similar attributes are not proven unique per product, and inventing one would replace a real
 * uniqueness contract with a plausible-looking guess.
 */

/**
 * B5: the canonical text form every metadata comparison in this repository runs on.
 *
 * Two rules, and deliberately no third:
 *
 * - **Unicode canonical composition.** Vietnamese copy reaches the editor in both precomposed and
 *   combining form depending on the operator's input method, and `"\u00c1o"` and `"A\u0301o"` are the
 *   *same text* by Unicode's own definition. Comparing them as different strings would let two
 *   byte-different but reader-identical PDPs publish.
 * - **`String.prototype.trim()`.** The editor's `parseTextField` already trims before it persists,
 *   and `hasText` in `catalog-acceptance.ts` reads presence the same way, so a value counts as
 *   present here exactly when it counts as present there. That is the JS whitespace set, not
 *   Postgres' ASCII-only `BTRIM`: a legacy NBSP-only row is absent on both sides.
 *
 * Case folding, internal whitespace collapsing and any similarity scoring are **out**. The owner
 * decision (B5) approves uniqueness of the pair, and a looser rule would refuse copy the owner
 * never banned. Widening this is an owner decision, not an implementation one.
 */
export function normalizeMetadataText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * The single grouping key for the `(seoTitle, seoDescription)` pair.
 *
 * `JSON.stringify` of the two normalized fields, so no separator character a human could type into
 * one field can forge or break a pair boundary: `("ab", "c")` and `("a", "bc")` stay distinct.
 */
export function metadataPairKey(title: string, description: string): string {
  return JSON.stringify([normalizeMetadataText(title), normalizeMetadataText(description)]);
}

/** The normalized pair a publish is allowed to claim. Both fields are present by construction. */
export type PublishedMetadataPair = Readonly<{
  seoTitle: string;
  seoDescription: string;
}>;

export type PublishMetadataRequirement = "SEO_TITLE_REQUIRED" | "SEO_DESCRIPTION_REQUIRED";

export type PublishMetadataReadiness =
  | Readonly<{ ok: true; pair: PublishedMetadataPair }>
  | Readonly<{ ok: false; reason: PublishMetadataRequirement }>;

/**
 * B5's publish precondition on one product's own copy: `PUBLISHED` requires both SEO fields to
 * carry text. It answers only what a single row can answer — the cross-product pair collision is a
 * catalog question and is checked against the published set at the persistence boundary.
 *
 * The title is reported first when both are missing: an editor fixes fields top to bottom, and one
 * concrete next step beats a list.
 */
export function readPublishMetadataReadiness(
  content: Readonly<{ seoTitle: string | null; seoDescription: string | null }>,
): PublishMetadataReadiness {
  const seoTitle = normalizeMetadataText(content.seoTitle);
  if (seoTitle === null) return { ok: false, reason: "SEO_TITLE_REQUIRED" };

  const seoDescription = normalizeMetadataText(content.seoDescription);
  if (seoDescription === null) return { ok: false, reason: "SEO_DESCRIPTION_REQUIRED" };

  return { ok: true, pair: { seoTitle, seoDescription } };
}

export type ProductMetadataUniquenessCandidate = Readonly<{
  slug: string;
  name: string;
  seoTitle: string | null;
  seoDescription: string | null;
}>;

export type ProductMetadataCopy = Readonly<{
  title: string;
  description: string;
}>;

export type ProductMetadataCollisionGroup = Readonly<{
  title: string;
  description: string;
  slugs: readonly string[];
}>;

export type ProductMetadataUniquenessVerdict = Readonly<{
  safeToRemoveSlugDiscriminator: boolean;
  collidingProductCount: number;
  collisions: readonly ProductMetadataCollisionGroup[];
}>;

/**
 * The copy a slug-free replacement contract would emit: the same published-or-fallback sentences as
 * today with the technical slug and path removed, and nothing else invented.
 */
export function buildSlugFreeProductCopy(
  product: ProductMetadataUniquenessCandidate,
): ProductMetadataCopy {
  return {
    title: product.seoTitle ?? product.name,
    description:
      product.seoDescription ?? `Thông tin sản phẩm ${product.name} tại ${BRAND.identity.name}.`,
  };
}

/**
 * Groups of products that the slug-free copy could not tell apart.
 *
 * A collision needs both the title and the description to match: a shared title alone still leaves
 * two distinguishable pages. Groups and the slugs inside them are sorted so the same catalog always
 * produces the same report regardless of query order.
 */
export function findProductMetadataCollisions(
  products: readonly ProductMetadataUniquenessCandidate[],
): readonly ProductMetadataCollisionGroup[] {
  const groups = new Map<string, { copy: ProductMetadataCopy; slugs: string[] }>();

  for (const product of products) {
    const copy = buildSlugFreeProductCopy(product);
    const key = metadataPairKey(copy.title, copy.description);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { copy, slugs: [product.slug] });
    else group.slugs.push(product.slug);
  }

  return [...groups.values()]
    .filter((group) => group.slugs.length > 1)
    .map((group) => ({
      title: group.copy.title,
      description: group.copy.description,
      slugs: [...group.slugs].sort(),
    }))
    .sort((left, right) =>
      left.title === right.title
        ? left.description.localeCompare(right.description)
        : left.title.localeCompare(right.title),
    );
}

/**
 * The gate W2b has to pass. `safeToRemoveSlugDiscriminator` is true only when the evaluated catalog
 * has no collision group at all — a partially collision-free catalog is not a licence to drop the
 * discriminator for the rest.
 */
export function evaluateProductMetadataUniqueness(
  products: readonly ProductMetadataUniquenessCandidate[],
): ProductMetadataUniquenessVerdict {
  const collisions = findProductMetadataCollisions(products);
  const collidingProductCount = collisions.reduce((total, group) => total + group.slugs.length, 0);

  return {
    safeToRemoveSlugDiscriminator: collisions.length === 0,
    collidingProductCount,
    collisions,
  };
}
