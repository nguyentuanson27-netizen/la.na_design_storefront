# ADR 0013 — Website-owned merchandising persistence

- Status: **Accepted for G4 design; additive migrations require Checkpoint B**
- Date: 2026-09-16
- Scope: G4 architecture only. No Prisma/schema migration is included.

## Context

Website-owned merchandising must remain separate from Pancake mirror facts and from `ProductMerchantFacts` (Merchant apparel overrides only). Current source provides useful owners already: `ProductContent`, `CollectionDefinition`, admin services guarded by `requireAdminSession`, and storefront readers.

PR #6 is merged into current `main`. It added the three approved size-guide definitions but explicitly left manual product-to-guide mapping to M1. The master spec permits reusing `ProductContent.sizeGuide` as the logical `sizeGuideId` when validated, so a duplicate column is unnecessary.

## Ownership matrix

| Concern | Current owner | Proposed owner | Migration? | Admin write | Storefront read |
|---|---|---|---|---|---|
| Product size-guide selection | `ProductContent.sizeGuide` exists but is generic text | reuse `ProductContent.sizeGuide` as validated logical guide ID | **A — NO MIGRATION** | extend existing product-content admin path, still behind `requireAdminSession` | product content/PDP resolves ID against approved Brand Config guides |
| Featured products ordering | `CollectionDefinition.featuredProductSlugs` ordered array | reuse as the collection/homepage curated featured order | **A — NO MIGRATION** | extend collection admin validation/write | existing public collection/homepage merchandising read |
| PLP default ordering | no field with full category-specific manual-order semantics | new category/collection product-order relation using stable product identities | **B — ADDITIVE MIGRATION REQUIRED** | collection merchandising admin transaction | collection/PLP repository applies explicit rank, then deterministic fallback |
| Mega-menu/category editorial image | `CollectionDefinition.heroImageUrl` (+ gallery/video media) | reuse `heroImageUrl` as the single category editorial image unless a future approved UI requires a distinct role | **A — NO MIGRATION** | collection admin media write | navigation/category reader consumes collection definition |
| Related-product override | no override; `storefront-related-products.ts` falls back through shared collections | new ordered source-product → target-product relation | **B — ADDITIVE MIGRATION REQUIRED** | product merchandising admin transaction | related-products reader uses manual targets first, then current same-collection fallback |
| Homepage/category merchandising state | `CollectionDefinition` (`homepagePosition`, publication, media, featured order, copy/SEO) | keep in `CollectionDefinition` | **A — NO MIGRATION** | existing/extended collection admin | existing collection/homepage readers |

## 1. Product size-guide selection — A: no migration

**Semantic name:** `sizeGuideId` at the application boundary.

**Persisted shape:** reuse nullable `ProductContent.sizeGuide String?`. Do not add `sizeGuideId` beside it. Future M1 should narrow its meaning from free editorial text to exactly one of:

- `ao-dai`
- `set-vay-form-rong`
- `set-vay-form-nho`

`null` means no guide selected. Category never infers a guide.

**Validation/write:** product-content admin validates the exact allowlist from Brand Config; the existing `requireAdminSession` boundary remains authoritative. Existing rows with null remain valid. If historical non-null free text exists, M1 must inventory it and fail closed/manual-remap rather than guess a logical ID.

**Read/fallback:** PDP resolves the persisted ID against the approved three-guide config. Unknown/stale values are treated as no valid guide and surfaced to admin/verification, not category-derived.

**Rejected:** duplicate column; category inference; storing the guide body on each product.

## 2. Featured products ordering — A: no migration

`CollectionDefinition.featuredProductSlugs String[]` is already documented in Prisma as “slugs the merchandiser pinned to the top of the grid, in the order they should appear.” Reuse it for curated featured order for a collection/homepage section.

Absence/empty array means no manual featured products. Admin writes must bound length, reject duplicates, resolve all referenced currently known products, and preserve submitted order. Storefront reads filter unavailable/unpublished entries rather than exposing stale references.

The existing field uses slugs, so this ADR does not pretend it has FK integrity. Converting it to IDs only for architectural preference would be an unrelated migration; leave it until a real stale-slug problem justifies migration.

## 3. PLP default ordering — B: additive migration required

`featuredProductSlugs` means “pinned/featured,” not “complete category default order”; overloading it would merge two user-visible semantics. A product can belong to several collections, so one global `ProductContent.sortOrder` would also be wrong.

Proposed shape for Checkpoint B review:

```prisma
model CollectionProductOrder {
  collectionId String
  productId    String
  position     Int

  collection CollectionDefinition @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  product    ProductMirror         @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@id([collectionId, productId])
  @@unique([collectionId, position])
  @@index([productId])
}
```

This is a category-specific ordered relation using stable internal product identity. No row means “not manually ranked.” Existing rows/products therefore retain the current deterministic fallback order.

Admin replacement/reorder must be bounded, reject duplicate product IDs/positions, require membership in the target collection where applicable, and write the order transactionally. Deleted products cascade out of the order. Products that become unpublished/inactive are skipped at read time; the persisted order can remain for later republication if the ProductMirror row remains.

## 4. Mega-menu/category editorial image — A: no migration

Reuse `CollectionDefinition.heroImageUrl` as the category's primary editorial image for category/mega-menu presentation. The repository already stores media references as URLs; do not store binary data in the database.

`null` means no editorial image and the UI must use its approved no-image behavior, not invent an asset. If a later design requires **different simultaneous** hero and mega-menu images, that is a new semantic requirement and should trigger a separate additive field review instead of silently overloading `galleryImageUrls`.

## 5. Related-product override — B: additive migration required

Current `storefront-related-products.ts` selects up to four products by shared collection and has no manual override. Manual-first ordering needs durable ordered references with referential integrity.

Proposed shape for Checkpoint B review:

```prisma
model RelatedProductOverride {
  sourceProductId String
  targetProductId String
  position        Int

  sourceProduct ProductMirror @relation("RelatedSource", fields: [sourceProductId], references: [id], onDelete: Cascade)
  targetProduct ProductMirror @relation("RelatedTarget", fields: [targetProductId], references: [id], onDelete: Cascade)

  @@id([sourceProductId, targetProductId])
  @@unique([sourceProductId, position])
  @@index([targetProductId])
}
```

The implementation will need the corresponding two named relation arrays on `ProductMirror`.

No rows means use the current same-collection fallback. With rows, read valid/published manual targets first in `position` order, then fill remaining capacity from the existing fallback while de-duplicating and excluding the source product. Bound overrides to the existing storefront capacity (currently four) unless M2/M3 later changes that approved UI capacity.

Admin writes reject self-reference, duplicates, unknown product IDs and out-of-range positions, and replace/reorder transactionally. Hard deletion cascades the reference; inactive/unpublished targets are skipped at read time and fallback fills the slot.

**Rejected:** comma-separated IDs, generic key/value CMS, mutable slugs for a new relation, or copying related product content into `ProductContent`.

## 6. Existing CollectionDefinition state stays authoritative

Do not duplicate these existing concerns elsewhere:

- `isPublished` — collection publication;
- `homepagePosition` — collection placement on homepage;
- `heroImageUrl`, `galleryImageUrls`, `videoSrcUrl`, `videoPosterUrl` — collection editorial media;
- `featuredProductSlugs` — manually ordered featured/pinned products;
- title/description/SEO fields — collection editorial/SEO content;
- `pancakeCategoryIds` — mapped category membership authority already owned by collection definition.

None belong in Pancake mirror columns or `ProductMerchantFacts`.

## Compatibility and integrity

- Brand #1/Core Kit compatibility: reused fields retain nullable/empty defaults; both new relation proposals are additive and absence preserves current behavior.
- All future writes remain behind `requireAdminSession` and server-side boundary validation.
- Bounded arrays/order inputs, uniqueness, nonnegative/contiguous positions and transactional replacement are required implementation invariants.
- No derived storefront state is persisted when it can be computed.
- Merchant availability/date authority is not stored in these merchandising relations.
- Provider credentials/config never belong in these tables.

## Migration boundary

**A — NO MIGRATION:** product size-guide selection (reuse column), featured order, category editorial image, existing homepage/category state.

**B — ADDITIVE MIGRATION REQUIRED:** collection-specific PLP default order; ordered related-product overrides.

**C — DEFERRED/PENDING:** none for the six requested ownership questions. A distinct mega-menu image becomes C only if a future approved design requires it to differ from the category hero.

Checkpoint B must approve the two B schema shapes before any Prisma migration is created. M1/M2/M3 are not implemented by this ADR.