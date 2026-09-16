# ADR 0013 — Website-owned merchandising persistence

- Status: **PARTIAL — settled owners recorded; category-owned concerns remain pending**
- Date: 2026-09-16
- Scope: G4 architecture only. No Prisma/schema migration is included.

## Context

Website-owned merchandising must remain separate from Pancake mirror facts and from `ProductMerchantFacts` (Merchant apparel overrides only). Current source provides useful owners already: `ProductContent`, `CollectionDefinition`, admin services guarded by `requireAdminSession`, and storefront readers.

PR #6 is merged into current `main`. It added the three approved size-guide definitions but explicitly left manual product-to-guide mapping to M1. The master spec permits reusing `ProductContent.sizeGuide` as the logical `sizeGuideId` when validated, so a duplicate column is unnecessary.

Two ownership boundaries are important for G4:

1. **Collections are not the approved category taxonomy.** `/collections` remains an aggregate/editorial collections surface and the master spec says child collections are currently unapproved. Current collection discovery is driven by `ProductContent.collectionSlugs` + published `CollectionDefinition` rows. `src/routes/collection.ts` resolves `/collections/[slug]` and uses `featuredProductSlugs` to pin products in that collection grid.
2. **The standalone homepage Featured-products section has no durable manual owner today.** `src/routes/home.ts` currently fills the homepage edit from the generic storefront discovery page. `CollectionDefinition.homepagePosition` controls which collections appear on the homepage; it does not own the separate manually selected/ordered product section required by master-spec §20.

The approved Brand #2 category/subcategory routes from master-spec §10 are not implemented yet. Current `src/brand/navigation.config.ts` still carries inherited destinations pending F3a/A6, and there is no category route/persistence contract that proves product membership for `Áo dài`, its subcategories, `Set đồ`, `Váy, đầm`, or `Phụ kiện`. Therefore this ADR must not silently promote `CollectionDefinition` into a category authority.

## Ownership matrix

| Concern | Current owner | Proposed owner | Classification | Admin write | Storefront read |
|---|---|---|---|---|---|
| Product size-guide selection | `ProductContent.sizeGuide` exists but is generic text | reuse `ProductContent.sizeGuide` as validated logical guide ID | **A — NO MIGRATION** | extend existing product-content admin path, still behind `requireAdminSession` | PDP resolves ID against approved Brand Config guides |
| Existing collection-grid pinned order | `CollectionDefinition.featuredProductSlugs` | keep its current collection-grid pinning semantic only | **A — NO MIGRATION** | existing/extended collection admin | `/collections/[slug]` only |
| Standalone homepage Featured products | no manual durable owner; current homepage uses generic discovery | dedicated global ordered product relation | **B — ADDITIVE MIGRATION REQUIRED** | homepage merchandising admin transaction | homepage Featured section only |
| Canonical category identity + membership | **none settled on current main** | must be designed before category-owned merchandising is approved | **C — DEFERRED/PENDING** | pending F3a/G4 category-authority decision | category/subcategory routes + all category consumers |
| Category PLP default ordering | no category authority to key an order to | key to the future canonical category authority | **C — DEFERRED/PENDING** | after category authority + Checkpoint B | category PLP only |
| Mega-menu/category editorial image | no canonical category owner; `CollectionDefinition.heroImageUrl` is collection media | key to the future canonical category authority | **C — DEFERRED/PENDING** | after category authority + Checkpoint B if persistence changes | category landing/mega-menu |
| Related-product manual override + fallback | current code has no override and falls back by shared **collection** | future contract is manual override first, then **same-category** fallback | **C — DEFERRED/PENDING** until category authority exists | after category authority + Checkpoint B | PDP related-products reader |
| Existing collection placement/media/content | `CollectionDefinition` (`homepagePosition`, publication, media, featured pins, copy/SEO) | keep as collection-owned state | **A — NO MIGRATION** | existing/extended collection admin | `/collections` + homepage collection navigation only |

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

## 2. Existing collection pinned order stays collection-owned — A: no migration

`CollectionDefinition.featuredProductSlugs String[]` already has one concrete contract: products the merchandiser pins to the top of **that collection's grid**, in order. `loadCollectionRoute()` consumes it exactly that way before tracking/view-model construction.

Keep that field scoped to `/collections/[slug]`. It is **not** the owner for master-spec §20 Homepage Featured products, and no special/fake `CollectionDefinition` row may be invented to make it one.

Existing collection admin validation should continue to bound length, reject duplicates and preserve submitted order. Storefront reads may skip unavailable/unpublished products rather than expose stale references.

## 3. Standalone homepage Featured products — B: additive migration required

Master-spec §20 requires a dedicated manually selected and admin-ordered homepage product section. No current homepage-level persistence matches that semantic: `homepagePosition` orders collection cards/links, while the homepage product edit currently comes from generic catalog discovery.

Smallest proposed website-owned authority for Checkpoint B review:

```prisma
model HomepageFeaturedProduct {
  productId String @id
  position  Int    @unique

  product ProductMirror @relation(fields: [productId], references: [id], onDelete: Cascade)
}
```

This is deliberately global: the approved homepage has one Featured-products section, so a fake parent collection or generic key/value CMS would add an owner that does not exist in product truth.

Admin replacement/reorder must be bounded, reject duplicate products/positions, use stable internal `ProductMirror.id`, and write transactionally. At read time, inactive/unpublished products are skipped; absence means the Featured section is empty. Per master-spec §20, an empty manual selection must **not** silently fall back to newest/bestseller logic.

The implementation will need the corresponding relation on `ProductMirror`; exact naming and capacity belong to M2/Checkpoint B implementation review.

## 4. Canonical category authority — C: deferred/pending prerequisite

Current main does **not** provide a canonical Brand #2 category identity/membership contract:

- `CollectionDefinition` + `ProductContent.collectionSlugs` define editorial collection membership and `/collections` discovery;
- `CollectionDefinition.pancakeCategoryIds` is a collection mapping field, not proof that the collection row is the public category identity;
- the approved category/subcategory route hierarchy is not active yet;
- there is no persisted relation that lets a consumer answer “which approved category owns this product?” independently of collections.

Before any category-owned G4 schema is accepted, F3a/G4 must record one canonical category contract with all of these invariants:

1. a stable key/slug for every approved category and subcategory;
2. explicit parent/child hierarchy for category → subcategory routes;
3. one authoritative product-membership source or persisted relation;
4. deterministic mapping from route path to that category identity;
5. `/collections` remains a separate namespace/semantic and does not become category truth by accident;
6. category membership is queryable by PDP/PLP consumers so “same-category” has one exact meaning.

This ADR does not invent a `CategoryDefinition` schema or Pancake-category derivation without evidence. Until that prerequisite is approved, category-dependent rows below remain C/PENDING rather than encoding the wrong taxonomy.

## 5. Category PLP default ordering — C: deferred/pending

Do not create `CollectionProductOrder` for Brand #2 category PLPs yet. A collection-scoped relation would answer the wrong identity question if categories and collections remain distinct.

After the canonical category authority exists, the smallest order owner should be an ordered category → product relation keyed by that authority and stable `ProductMirror.id`. Admin replacement/reorder must be bounded, transactional, duplicate-free, membership-validating, and deterministic for unranked products.

F4a/M3b cannot treat this concern as approved until the category authority is settled and Checkpoint B approves any resulting additive schema.

## 6. Mega-menu/category editorial image — C: deferred/pending

`CollectionDefinition.heroImageUrl` remains valid **collection** media. Reusing it as category/mega-menu media would conflate two public concepts without a proven one-to-one identity.

Once the category authority is approved, attach the category editorial image to that owner (or to a narrow category-merchandising record keyed by it). `null` means no editorial image; the UI must use its approved no-image behavior rather than invent an asset.

A later need for separate category-hero and mega-menu images is a distinct semantic requirement and should be reviewed separately rather than hidden in `galleryImageUrls`.

## 7. Related products — C: deferred/pending until same-category is well-defined

Current `storefront-related-products.ts` falls back through shared **collections**. That is baseline behavior, not the Brand #2 target contract. Master spec requires:

1. manual admin selection first;
2. if absent/insufficient, fill from **same-category** products.

Do not preserve same-collection fallback merely because it exists today. The manual ordered override can still use stable product IDs in a future additive relation, but the full M3a contract is not architecture-complete until the canonical category membership authority from §4 exists.

When resolved, reads must preserve manual order, skip invalid/unpublished targets, de-duplicate, exclude the source product, and fill remaining capacity from the canonical same-category query. No collection fallback is allowed unless a later approved decision formally makes collection membership equivalent to category membership.

## 8. Existing CollectionDefinition state remains collection-owned

Do not duplicate these existing **collection** concerns elsewhere:

- `isPublished` — collection publication;
- `homepagePosition` — placement of collection entries on homepage collection navigation/merchandising;
- `heroImageUrl`, `galleryImageUrls`, `videoSrcUrl`, `videoPosterUrl` — collection editorial media;
- `featuredProductSlugs` — manually ordered pins within that collection grid;
- title/description/SEO fields — collection editorial/SEO content;
- `pancakeCategoryIds` — existing collection mapping data.

None of these facts, by themselves, establish Brand #2 category identity. None belong in Pancake mirror columns or `ProductMerchantFacts`.

## Compatibility and integrity

- Brand #1/Core Kit compatibility: reused fields keep their current semantics; this ADR does not repurpose existing collection data.
- All future writes remain behind `requireAdminSession` and server-side boundary validation.
- Ordered admin inputs must be bounded, unique and transactionally replaced.
- New relations use stable internal product identity rather than mutable product slugs where referential integrity is required.
- No derived storefront state is persisted when it can be computed.
- Merchant availability/date authority is not stored in merchandising relations.
- Provider credentials/config never belong in these tables.

## Migration boundary

**A — NO MIGRATION:** product size-guide selection; existing collection-grid pinned order; existing collection placement/media/content.

**B — ADDITIVE MIGRATION REQUIRED:** dedicated standalone homepage Featured-product order, subject to Checkpoint B.

**C — DEFERRED/PENDING:** canonical category identity/membership authority; category PLP manual order; category/mega-menu editorial image ownership; related-product manual/fallback contract that depends on exact same-category semantics.

G4 therefore remains **not complete**. The next architecture step is to settle the category identity/membership authority as part of F3a/G4 before approving M3a/M3b or category-media persistence. No migration is created by this ADR.