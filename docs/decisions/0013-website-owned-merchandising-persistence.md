# ADR 0013 — Website-owned merchandising persistence

- Status: **ACCEPTED — category authority settled; one additive migration set pending Checkpoint B**
- Date: 2026-09-16
- Scope: G4 architecture only. No Prisma/schema migration is created or run by this ADR.
- Supersedes: the `PARTIAL` revision of 2026-09-16, whose §4–§7 predate the merged category routes.

## Context

Website-owned merchandising must remain separate from Pancake mirror facts and from `ProductMerchantFacts` (Merchant apparel overrides only). Current source provides useful owners already: `ProductContent`, `CollectionDefinition`, admin services guarded by `requireAdminSession`, and storefront readers.

PR #6 is merged into current `main`. It added the three approved size-guide definitions but explicitly left manual product-to-guide mapping to M1. The master spec permits reusing `ProductContent.sizeGuide` as the logical `sizeGuideId` when validated, so a duplicate column is unnecessary.

Two ownership boundaries are important for G4:

1. **Collections are not the approved category taxonomy.** `/collections` remains an aggregate/editorial collections surface and the master spec says child collections are currently unapproved. Current collection discovery is driven by `ProductContent.collectionSlugs` + published `CollectionDefinition` rows. `src/routes/collection.ts` resolves `/collections/[slug]` and uses `featuredProductSlugs` to pin products in that collection grid.
2. **The standalone homepage Featured-products section has no durable manual owner today.** `src/routes/home.ts` currently fills the homepage edit from the generic storefront discovery page. `CollectionDefinition.homepagePosition` controls which collections appear on the homepage; it does not own the separate manually selected/ordered product section required by master-spec §20.

The approved Brand #2 category/subcategory routes from master-spec §10 **now exist on `main`**. PR #5 merged F3a/A6/A8: `src/brand/category.config.ts` declares the approved taxonomy once, `src/brand/navigation.config.ts` spreads it into primary navigation, and `src/app/ao-dai/**`, `src/app/set-do/**`, `src/app/vay-dam` and `src/app/phu-kien` serve crawlable pages that the route manifest, sitemap and indexable-path patterns all derive from the same declaration.

What PR #5 deliberately did **not** add is product membership. The category routes render a landing shell and link to `/shop`; they read no product relation. So the open G4 question was never "do categories exist" — it is "what owns the product ↔ category relation", and that is what this revision settles. `CollectionDefinition` is still not promoted into a category authority.

## Ownership matrix

| Concern | Current owner | Proposed owner | Classification | Admin write | Storefront read |
|---|---|---|---|---|---|
| Product size-guide selection | `ProductContent.sizeGuide` exists but is generic text | reuse `ProductContent.sizeGuide` as validated logical guide ID | **A — NO MIGRATION** | extend existing product-content admin path, still behind `requireAdminSession` | PDP resolves ID against approved Brand Config guides |
| Existing collection-grid pinned order | `CollectionDefinition.featuredProductSlugs` | keep its current collection-grid pinning semantic only | **A — NO MIGRATION** | existing/extended collection admin | `/collections/[slug]` only |
| Standalone homepage Featured products | no manual durable owner; current homepage uses generic discovery | dedicated global ordered product relation | **B — ADDITIVE MIGRATION REQUIRED** | homepage merchandising admin transaction | homepage Featured section only |
| Canonical category **identity**/hierarchy | `src/brand/category.config.ts` (merged by F3a) | ratify it as the canonical authority; add `category-taxonomy.ts` as its query/invariant boundary | **A — NO MIGRATION** | none: taxonomy is code, changed by deploy | every category consumer |
| Canonical product ↔ category **membership** | **none on current main** | `ProductCategoryTree` + `ProductCategoryMembership`, keyed by `ProductMirror.id` and category key | **B — ADDITIVE MIGRATION REQUIRED** | category-membership admin transaction | category PLP, PDP, related products |
| Category PLP default ordering | no owner | `CategoryProductOrder`, keyed by the same category key | **B — ADDITIVE MIGRATION REQUIRED** | category merchandising admin transaction | category PLP only |
| Mega-menu/category editorial image | no canonical category owner; `CollectionDefinition.heroImageUrl` is collection media | `CategoryEditorialMedia`, keyed by the same category key | **B — ADDITIVE MIGRATION REQUIRED** | category merchandising admin | category landing/mega-menu |
| Related-product manual override + fallback | current code has no override and falls back by shared **collection** | manual override first, then same-subcategory, then same parent tree; no collection fallback | **B — ADDITIVE MIGRATION REQUIRED** (override relation) | related-products admin transaction | PDP related-products reader |
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

## 4. Canonical category authority — SETTLED

### 4.1 Identity and hierarchy are code, not data — A: no migration

`src/brand/category.config.ts::CATEGORY_NAVIGATION` is ratified as **the** canonical Brand #2
category taxonomy. It already declares each approved category exactly once with a stable `key`, a
route `href` and explicit `children`, and navigation, the route manifest, the sitemap's static
canonical paths and the indexable-path patterns are all derived from it.

A `CategoryDefinition` table was considered and rejected. A database row cannot create a route —
App Router resolves `/ao-dai/tet` from `src/app/ao-dai/tet/page.tsx` on disk — so adding a category
requires a deploy no matter where its definition lives. Persisting the taxonomy would therefore buy
no operational flexibility while creating a second authority free to disagree with the routes,
which is the exact failure this ADR exists to prevent. The taxonomy is owner-approved, fixed and
eleven nodes deep; it is brand vocabulary, not merchandiser-managed content.

`src/commerce/category-taxonomy.ts` is the query/invariant boundary over that config and the module
every consumer must go through. It resolves a category by key or by route path, exposes
parent/child/ancestor structure, computes the listing key set for a category, derives the
membership bound from the taxonomy, and validates admin membership submissions fail-closed.

**Non-conflation evidence on current `main`:**

- `src/brand/category.config.ts`, `src/routes/category.tsx` and `src/routes/category-destinations.ts`
  contain no reference to `CollectionDefinition`, `collectionSlugs` or `pancakeCategoryIds`; the
  category routes read no product or collection relation at all.
- `pancakeCategoryIds` appears only in `collection-definition.ts`, `collection-definition-admin.ts`
  and `collection-definition-repository.ts` — always collection-scoped, never a category identity.
- `tests/domain/category-taxonomy.test.ts` asserts that `/collections`, `/collections/<slug>`,
  `/new-arrivals`, `/sale` and `/shop` never resolve as category identities.

### 4.2 Stable identities

| Concern | Identity | Why |
|---|---|---|
| Category | `CategoryNode.key` (`aoDaiTet`) | The master spec still expects category SEO copy to be drafted for approval, so a slug may yet be renamed. Keying rows to the route path would turn an SEO edit into a data migration; keying them to the stable code identity makes it a config-only change. |
| Product | `ProductMirror.id` (cuid) | Slugs are mutable — `ProductSlugHistory` exists precisely because they change. Referential integrity must not depend on a mutable field. |

### 4.3 Owner-approved membership rules

1. A product may belong to several categories/subcategories.
2. A product may **not** belong to two different top-level trees. `Áo dài Tết` + `Áo dài 4 tà` is
   valid; `Áo dài Tết` + `Set váy` is not.
3. Subcategory membership **projects into the parent listing automatically**. Admins never duplicate
   an assignment into the parent just to have the product appear on the parent PLP.
4. Website admin assigns membership manually, and website-owned membership is the source of truth.
   Canonical membership is never derived from Pancake category, `CollectionDefinition`,
   `ProductContent.collectionSlugs`, or navigation config.

Rule 3 is satisfied by query widening, not by writing derived rows: a listing for category `X`
matches `categoryListingKeys(X)` — `X` plus every descendant. Only the assigned node is persisted,
which keeps membership single-valued and makes re-parenting a config change rather than a backfill.

### 4.4 The one rule the owner has not settled

For a parent that has children (`Áo dài`, `Set đồ`), may a product be assigned **directly to the
parent and to no child**?

This is **OWNER DECISION PENDING**. It does not change the schema, the queries or any consumer
contract: both answers are expressible against the shape below, so it is carried as an explicit
validation policy flag (`CategoryMembershipPolicy.requireLeafMembership`) with no default, and
`tests/domain/category-taxonomy.test.ts` pins both behaviours. Settling it later requires a policy
value and a review of rows already written — **no migration**. Childless top-level categories
(`Váy, đầm`, `Phụ kiện`) are unaffected: they have no leaf to require.

### 4.5 Proposed persistence — B: additive migration, pending Checkpoint B

```prisma
/// One row per product that has any category membership. Holds the single top-level tree the
/// product belongs to, so top-level exclusivity is a database fact and not only a service rule.
model ProductCategoryTree {
  productId   String @id
  topLevelKey String

  product     ProductMirror               @relation(fields: [productId], references: [id], onDelete: Cascade)
  memberships ProductCategoryMembership[]

  @@unique([productId, topLevelKey])
}

/// The assigned categories themselves. `topLevelKey` is carried so the composite foreign key below
/// can bind every membership to the product's one tree.
model ProductCategoryMembership {
  productId   String
  topLevelKey String
  categoryKey String
  createdAt   DateTime @default(now())

  tree ProductCategoryTree @relation(fields: [productId, topLevelKey], references: [productId, topLevelKey], onDelete: Cascade)

  @@id([productId, categoryKey])
  @@index([categoryKey])
}
```

`ProductCategoryTree.productId` is the primary key, so a product has at most one `topLevelKey`; the
composite foreign key then forces every membership row to carry that same value. Two memberships in
different top-level trees are therefore **unrepresentable**, not merely rejected. This follows the
existing house pattern where a database constraint is defence in depth behind application
validation, as ADR 0007 states for the Merchant enums.

What the database cannot check is that `categoryKey` actually sits under `topLevelKey`, because the
taxonomy lives in code. That check is `parseCategoryMembership()` at the admin boundary, which fails
closed on unknown keys, duplicates, oversized input and cross-tree selections.

`@@index([categoryKey])` serves the PLP query, which filters on the listing key set. The expected
row count is small — products × at most `MAX_CATEGORY_MEMBERSHIPS` (6 today) — so no further index
is proposed until a measured need exists.

**Alternative considered — one table, validation only.** A single `ProductCategoryMembership` with
`@@id([productId, categoryKey])` and no tree row is simpler to read and one table fewer. It was not
chosen because top-level exclusivity would then rest entirely on application code: any future path
that inserts a row without going through `parseCategoryMembership()` — a script, a fixture, a
repair query — could split a product across two trees, and nothing would detect it until a PLP
showed the product in the wrong place. The two-table shape costs one extra table and makes that
state impossible to write. Checkpoint B may overrule this trade; if it does, the validation,
queries and every consumer contract above are unchanged, because only the storage differs.

### 4.6 Admin write contract

- Behind `requireAdminSession`, like every other merchandising write.
- Input parsed by `parseCategoryMembership()` before any database access; bounded by
  `MAX_CATEGORY_MEMBERSHIPS`, which is derived from the taxonomy rather than written down.
- **Full replacement inside one transaction**: delete the product's membership rows, upsert or
  delete its tree row, insert the new set. No incremental add/remove path, so a product is never
  observed mid-edit spanning two trees.
- Clearing all categories deletes the tree row; `topLevelKey` is never left orphaned.

### 4.7 Storefront query contract

- **Category PLP** for category `X`: products whose membership `categoryKey` is in
  `categoryListingKeys(X)`, de-duplicated by product, then filtered by existing storefront
  availability truth. This is the single place parent projection happens.
- **PDP** reads the product's own membership set for breadcrumbs and for the related-products seed.
- Membership never overrides availability, publication or promotion truth; it only selects.

## 5. Category PLP default ordering — B: additive migration, pending Checkpoint B

```prisma
model CategoryProductOrder {
  categoryKey String
  productId   String
  position    Int

  product ProductMirror @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@id([categoryKey, productId])
  @@unique([categoryKey, position])
}
```

Keyed by `categoryKey` — the same identity as membership — so a parent PLP can carry its own manual
order over the union it lists, which a membership-scoped `position` column could not express: a
product inherited into `/ao-dai` has no membership row for `aoDai` to rank.

Order is deliberately **separate from membership**. Membership answers "is this product in this
category"; order answers "where does it sit on this category's page". Merging them would make an
unranked product indistinguishable from an unassigned one.

Admin replacement must be bounded, transactional, duplicate-free and membership-validating.
Unranked products follow a deterministic documented tail order rather than database order.
`CollectionProductOrder` is **not** created: a collection-scoped relation would answer the wrong
identity question.

## 6. Mega-menu/category editorial image — B: additive migration, pending Checkpoint B

```prisma
model CategoryEditorialMedia {
  categoryKey      String  @id
  heroImageUrl     String?
  megaMenuImageUrl String?
  updatedAt        DateTime @updatedAt
}
```

Two explicit nullable fields rather than one, because master-spec §21 (category editorial) and §24
(mega menu) are distinct surfaces with distinct crops. The previous revision already warned against
hiding a second image inside `galleryImageUrls`; naming both is the honest shape.

`CollectionDefinition.heroImageUrl` remains **collection** media and is not reused: reusing it would
assert a one-to-one collection ↔ category identity that does not exist. `null` means no editorial
image and the UI uses its approved no-image behaviour rather than inventing an asset.

## 7. Related products — contract settled; override relation pending Checkpoint B

The owner-approved resolution order is exactly:

1. **Manual override first**, in the admin's order.
2. Then products sharing the **same subcategory** — the most specific categories the source product
   is assigned to.
3. Then widen to the **same parent tree**, i.e. `categoryListingKeys(topLevelKey)`.
4. **No collection fallback at any stage.**

In all stages: exclude the source product, de-duplicate by product, drop products that are inactive,
unpublished or unavailable by existing storefront truth, and preserve manual order ahead of any
filled candidate.

The existing shared-collection fallback in `src/commerce/storefront-related-products.ts` is
**superseded** and must be removed when F7d/M3a implement this contract; it is not preserved merely
because it exists. Step 1 needs one additive relation:

```prisma
model RelatedProductOverride {
  productId        String
  relatedProductId String
  position         Int

  product ProductMirror @relation("RelatedSource", fields: [productId], references: [id], onDelete: Cascade)
  related ProductMirror @relation("RelatedTarget", fields: [relatedProductId], references: [id], onDelete: Cascade)

  @@id([productId, relatedProductId])
  @@unique([productId, position])
}
```

Self-reference (`productId = relatedProductId`) must be rejected at the admin boundary and by a
database check constraint. Steps 2–4 need no new storage: they are queries over §4.5 membership.

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

## Three distinct merchandising namespaces

These are separate public concepts with separate owners. Nothing below may be collapsed into
anything else without a new decision.

| Namespace | Owner | Public surface | Product selection |
|---|---|---|---|
| **Category** | `category.config.ts` taxonomy + `ProductCategoryMembership` | `/ao-dai`, `/set-do/set-vay`, … | manual admin membership, one top-level tree, parent projects from child |
| **Collection** | `CollectionDefinition` + `ProductContent.collectionSlugs` | `/collections`, `/collections/<slug>` | editorial collection membership, pinned by `featuredProductSlugs` |
| **Homepage Featured** | `HomepageFeaturedProduct` (§3) | one homepage section | one global manually ordered list |

Specifically: a collection is **not** a category even when their slugs resemble each other; a
category is **not** a collection even though both list products; and the homepage Featured section
is neither, which is why it does not reuse `CollectionDefinition.featuredProductSlugs`. Pancake
category data (`CollectionDefinition.pancakeCategoryIds`) is an external mapping field and is never
the canonical website taxonomy.

## Migration boundary

**A — NO MIGRATION:** product size-guide selection; existing collection-grid pinned order; existing
collection placement/media/content; **canonical category identity and hierarchy** (code/config plus
`category-taxonomy.ts`, which this ADR's accompanying change already lands with domain tests).

**B — ADDITIVE MIGRATION REQUIRED — all subject to Checkpoint B, none created or run by this ADR:**

| Model | Purpose | Section |
|---|---|---|
| `HomepageFeaturedProduct` | standalone homepage Featured order | §3 |
| `ProductCategoryTree` | the product's single top-level tree | §4.5 |
| `ProductCategoryMembership` | product ↔ category assignment | §4.5 |
| `CategoryProductOrder` | category PLP manual default order | §5 |
| `CategoryEditorialMedia` | category hero + mega-menu images | §6 |
| `RelatedProductOverride` | manual related-product selection | §7 |

Every one is additive: new tables plus the matching back-relations on `ProductMirror`. No existing
column changes meaning, and no existing row needs rewriting.

**C — DEFERRED/PENDING:** nothing category-related remains in this class. The only open category
item is the §4.4 parent-only membership rule, which is an **owner decision**, not an architecture
gap, and carries no migration either way.

## Backfill

There is none, and none is permitted. Category membership is owner-assigned editorial truth, so
existing products start with no membership and appear on no category PLP until an admin assigns
them. Deriving an initial membership from `collectionSlugs`, Pancake category or product-name
matching would install exactly the conflation this ADR forbids, under the cover of a one-off script.
Populating the catalogue is admin work, and empty category listings before that work is done are
correct behaviour, not a defect.

## Status of G4

G4 is **architecture-complete**: one canonical category authority now exists, with stable identity,
explicit hierarchy, deterministic path resolution, a website-owned membership shape, a
database-enforced one-top-level invariant, child-to-parent projection without derived rows, and a
single query contract that PLP order, category media and related products all key to.

M2, M3a, M3b, F4a, F7d and category/mega-menu editorial media are unblocked **at the architecture
level** and remain behind their existing plan dependencies and Checkpoint B for the migrations
listed above. G5 is untouched by this ADR.