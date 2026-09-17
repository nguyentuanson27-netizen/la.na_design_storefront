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
| Canonical product ↔ category **membership** | **none on current main** | `ProductCategoryMembership`, keyed by `ProductMirror.id` and category key; top-level tree derived, not stored | **B — ADDITIVE MIGRATION REQUIRED** | category-membership admin transaction, application-enforced invariant | category PLP, PDP, related products |
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

## 3. Standalone homepage Featured products — IMPLEMENTED (M2)

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
| Category | `CategoryNode.key` (`aoDaiTet`) | The master spec still expects category SEO copy to be drafted for approval, so a slug may yet be renamed. Keying rows to the route path would turn an SEO edit into a data migration; keying them to the stable code identity means a slug rename touches no row at all. |
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
which keeps membership single-valued and keeps every taxonomy change **free of schema migration**.

That is not the same as free of data work. Re-parenting a category can turn rows that were valid
under the old tree into a split product under the new one, without any membership write happening —
so a taxonomy change is itself a way around the §4.6 boundary. §4.8 is the gate for that.

### 4.4 Parent-only membership — SETTLED, owner-approved 2026-09-16

For a parent that has children (`Áo dài`, `Set đồ`), may a product be assigned **directly to the
parent and to no child**? **Yes.** The owner approved it on 2026-09-16, recorded in
[`la-na-design-owner-approved-facts-and-decisions.md`](../specs/la-na-design-owner-approved-facts-and-decisions.md)
› Settled decisions, which is this repository's fact authority and carries the provenance.

So a product may sit on `Áo dài` alone. It appears on `/ao-dai` — the listing matches the category
itself, not only its descendants (§4.7) — and on no subcategory page, which is the truthful outcome:
nobody has said which subcategory it belongs to, and the architecture must not guess one.

The rule is carried as `APPROVED_CATEGORY_MEMBERSHIP_POLICY` (`requireLeafMembership: false`) rather
than hard-coded into the validator. `CategoryMembershipPolicy` stays a required parameter with no
default, so every admin path names the policy it is applying and a future change to this decision is
one constant plus a data review — still **no migration**.
`tests/domain/category-taxonomy.test.ts` pins the approved behaviour and keeps the rejecting
behaviour covered, so the flag cannot rot into a no-op. Childless top-level categories
(`Váy, đầm`, `Phụ kiện`) were never affected: they have no leaf to require.

### 4.5 Persistence — IMPLEMENTED

```prisma
/// Website-owned category assignment. One row per (product, assigned category).
///
/// Only the assigned node is stored. The product's top-level tree is *derived* through the
/// taxonomy (`categoryByKey(categoryKey).topLevelKey`) and never persisted — see below.
model ProductCategoryMembership {
  productId   String
  categoryKey String
  createdAt   DateTime @default(now())

  product ProductMirror @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@id([productId, categoryKey])
  @@index([categoryKey])
}
```

`@@index([categoryKey])` serves the PLP query, which filters on the listing key set. The expected
row count is small — products × at most `MAX_CATEGORY_MEMBERSHIPS` (6 today) — so no further index
is proposed until a measured need exists.

#### Top-level exclusivity is application-enforced, and this ADR does not pretend otherwise

`parseCategoryMembership()` rejects a cross-tree selection, and §4.6 requires the admin write to be
a single transactional full replacement, so no validated path can produce a split product. **The
database does not enforce it.** Any writer that bypasses the admin boundary — a fixture, a repair
query, a migration script — can create a split product, and nothing in the schema will refuse it.
That limitation is stated here rather than engineered around, because the two attempts to engineer
around it both cost more than they are worth:

**Rejected — a per-product tree row with a composite foreign key.** An earlier revision of this ADR
proposed `ProductCategoryTree(productId @id, topLevelKey)` with membership carrying `topLevelKey`
and a composite FK back to it, and claimed that made a cross-tree product *unrepresentable*. **That
claim was wrong.** The FK only proves that every membership row repeats the same `topLevelKey`
string; it cannot prove that `categoryKey` sits under it, because the taxonomy is not in the
database. So this passes the FK:

```text
ProductCategoryTree(productId = P, topLevelKey = "aoDai")
ProductCategoryMembership(productId = P, topLevelKey = "aoDai", categoryKey = "setVay")
```

and under the §4.7 PLP contract that product still surfaces on `/set-do`, because the listing
matches on `categoryKey`. The shape bought an extra table and a duplicated string, and enforced
nothing. It also broke the re-parenting property below, by persisting `topLevelKey` in two places.

**Rejected — teaching the database the taxonomy.** A `CHECK` constraint enumerating every
`categoryKey → topLevelKey` pair, or a mirrored `CategoryNode`/closure table as an FK target, would
genuinely enforce the invariant. Both put a second copy of the taxonomy in SQL, which §4.1 rejects
for the same reason it rejects a `CategoryDefinition` table — and worse, both make adding or
re-parenting a category require a **migration**, destroying the migration-free property that §4.1,
§4.3 and §4.8 depend on. The invariant is not worth paying that price to enforce in two places.

**Accepted instead — detect what the schema cannot prevent.** Alongside the admin validation,
`findCategoryMembershipViolations()` reports any product whose memberships span more than one
top-level tree, or whose `categoryKey` is not in the current taxonomy. It is pure and read-only, so
it already ships with this ADR and is covered by domain tests — including the exact counterexample
above — rather than waiting on the migration. This is the pattern the repository already uses for
facts it cannot constrain in the schema (`scripts/mirrored-money-audit.ts`,
`scripts/merchant-identity-audit.ts`); wiring it to a script over real rows belongs with the
Checkpoint B migration. It catches exactly the bypass-the-boundary case the rejected FK only
appeared to cover, and stale `categoryKey` values after a taxonomy edit surface through the same
check.

#### Why nothing derived is persisted

Storing only `categoryKey` is what keeps a taxonomy edit out of the schema. Moving a category to a
different root changes one line of `category.config.ts`; every listing and every derived
`topLevelKey` follows immediately, and **no column and no migration is involved**. The rejected
tree-row shape would additionally have left a stale persisted `topLevelKey` on every affected
product, so it needed a data rewrite *and* carried a value that could disagree with the taxonomy.

This is deliberately not a promise that no row ever needs attention. A re-parenting can invalidate
rows it does not touch, and §4.8 says what to do about that.

### 4.6 Admin write contract

- Behind `requireAdminSession`, like every other merchandising write.
- Input parsed by `parseCategoryMembership()` before any database access; bounded by
  `MAX_CATEGORY_MEMBERSHIPS`, which is derived from the taxonomy rather than written down.
- **Full replacement inside one transaction**: delete the product's membership rows, insert the
  validated set. No incremental add/remove path, so a product is never observed mid-edit spanning
  two trees. This transaction is the *only* place the one-top-level invariant is enforced, which is
  why it may not be bypassed by any other write path.
- Clearing all categories deletes every membership row for the product; nothing derived is left behind, because nothing derived is stored.

### 4.7 Storefront query contract

- **Category PLP** for category `X`: products whose membership `categoryKey` is in
  `categoryListingKeys(X)`, de-duplicated by product, then filtered by existing storefront
  availability truth. This is the single place parent projection happens.
- **PDP** reads the product's own membership set for breadcrumbs and for the related-products seed.
- Membership never overrides availability, publication or promotion truth; it only selects.

### 4.8 Taxonomy changes are gated, not free

A taxonomy edit writes no membership row, which is exactly why it is dangerous: the §4.6 validation
boundary never runs, so it is the one operation that can break the one-top-level invariant without
anybody writing membership data.

Worked example. Product `P` holds `aoDaiTet` + `aoDai4Ta`, valid because both derive to `aoDai`. A
deploy re-parents `aoDaiTet` under `setDo`. No row changes, no admin write happens, and `P` now
derives to two roots — under §4.7 it can surface in both top-level trees.

**Operational contract.** Re-parenting, renaming a key, and removing a category stay
migration-free, but before a taxonomy change is activated:

1. Build the **proposed** taxonomy with `buildCategoryTaxonomy()`.
2. Run `findCategoryMembershipViolations(rows, proposedTaxonomy)` over existing membership rows.
3. Run `findOrphanedCategoryKeys(records, proposedTaxonomy)` over **every** category-keyed owner —
   `ProductCategoryMembership`, `CategoryProductOrder` and `CategoryEditorialMedia`. Membership is
   not the only table storing a raw key, and the others have no invariant of their own to make the
   staleness visible.
4. Reconcile everything either audit reports — cross-tree memberships, and orphaned order/media rows
   — through the normal admin write boundary.
5. **Do not activate while violations remain.**

Passing the proposed taxonomy is what makes this a gate rather than a post-mortem: the same function
answers "what is broken now?" with the current taxonomy and "what would this deploy break?" with the
proposed one. `tests/domain/category-taxonomy.test.ts` covers the valid-before → invalid-after case
above, so the seam cannot quietly disappear.

Until those rows exist, steps 1–5 are vacuous — which is the situation on this branch, and the
reason this is an operational contract rather than something to automate now. Wiring it into a
release script belongs with the Checkpoint B migration that first creates those rows.

### 4.9 Category keys are retired permanently, never reused

A `categoryKey` that has been in production is **retired for good**. A new category always gets a new
key, even when it occupies the old one's route path or label.

This is a safety rule, not bookkeeping. Every category-keyed table stores the key as a bare string
with no foreign key to enforce anything. If a retired key were reassigned to a different category,
any order or media row the §4.8 gate failed to clean would silently reattach itself to the new
category — stale merchandising going live without a single write. Retirement removes the only way
that can happen, by policy: the key never comes back.

To be exact about what that is and is not — this is a rule people follow, not a constraint the
database enforces. Nothing stops a writer from reusing a retired key, and §4.8's audit reports
unknown keys but cannot recognise a *reused* one, because after reuse the key is valid again. The
rule is the protection; there is no schema guarantee behind it.

Renaming a category's **label** or **route path** is unrelated and free; neither is persisted in
merchandising rows (§4.2). Only the key is, and only the key is permanent.

## 5. Category PLP default ordering — IMPLEMENTED (M3b)

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

## 6. Mega-menu/category editorial image — IMPLEMENTED (M2)

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

## 7. Related products — IMPLEMENTED (M3a)

The owner-approved resolution order is exactly:

1. **Manual override first**, in the admin's order.
2. Then products sharing the **same subcategory** — the most specific categories the source product
   is assigned to.
3. Then widen to the **same parent tree**, i.e. `categoryListingKeys(topLevelKey)`.
4. **No collection fallback at any stage.**

In all stages: exclude the source product, de-duplicate by product, drop products that are inactive,
unpublished or unavailable by existing storefront truth, and preserve manual order ahead of any
filled candidate.

#### Deterministic order inside stages 2 and 3

Stage order alone is not a contract: PostgreSQL row order is not stable, so two runs over identical
data could return different related products. M3a requires deterministic related order, so the
automatic stages are fully specified here rather than left to the database.

**Traversal across categories.** A product may hold several assigned categories. They are visited in
the taxonomy's **declared order** — the same normalization `parseCategoryMembership()` already
applies, so the stored set and the traversal agree. Stage 2 visits each assigned category; stage 3
visits `categoryListingKeys(topLevelKey)`. Because stage 2's candidates are a subset of stage 3's,
de-duplication alone produces "closest first, then widen" without a separate exclusion rule.

**Order within one category**, applied in full before moving to the next:

1. products the merchandiser ranked for that category, by `CategoryProductOrder.position` ascending;
2. then everything else, by `name` ascending;
3. then `ProductMirror.id` ascending as the final tie-break.

Step 1 makes related products agree with the category PLP a visitor just came from, reusing the §5
owner rather than inventing a second order. Steps 2–3 are the ordering this repository already uses
for catalog reads (`orderBy: [{ name: "asc" }, { id: "asc" }]` in `storefront-catalog.ts` and
`catalog-mirror-repository.ts`), so the fallback matches the rest of the catalogue instead of
introducing a third convention. `id` is unique and never null, which makes the total order complete:
no tie can reach the database's discretion.

M3a tests must pin this order, including the multi-subcategory traversal and the
ranked-before-unranked boundary.

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
- No derived storefront state is persisted when it can be computed. Category top-level membership
  is derived from the taxonomy at read time, never stored.
- Where an invariant cannot be expressed in the schema, it is enforced at one validated write
  boundary and **audited** rather than claimed as a database guarantee (§4.5). The audit covers every
  table that stores a `categoryKey`, not only the one that has an invariant of its own (§4.8).
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

**B — ADDITIVE MIGRATION REQUIRED — Checkpoint B approved all five on 2026-09-16
([fact authority](../specs/la-na-design-owner-approved-facts-and-decisions.md) › Settled decisions);
none is created or run by this ADR, which stays architecture-only:**

| Model | Purpose | Section |
|---|---|---|
| `HomepageFeaturedProduct` | standalone homepage Featured order | §3 |
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

## Implementation status — M2 / M3a / M3b, 2026-09-17

All five approved models exist as of migration
`20260917050000_add_website_owned_merchandising`. Additive only; **no backfill was run**, so
category membership starts empty and admin-assigned exactly as the approval requires.

| Concern | Shipped as |
|---|---|
| Validation (§3, §5, §6, §7) | `src/commerce/merchandising-input.ts` |
| Authorization boundary (§4.6) | `src/commerce/merchandising-admin.ts` |
| Persistence and reads | `src/commerce/merchandising-repository.ts` |
| Related resolution (§7) | `src/commerce/storefront-related-products.ts` |

Three things are worth stating plainly rather than leaving to inference:

- **The superseded shared-collection fallback is gone**, not kept as a last resort. It answered a
  different identity question, and keeping it would have preserved the collection ↔ category
  conflation this ADR exists to separate. A product with no categories and no manual picks now has
  no related products, which is the truthful answer.
- **The §7 order is decided in TypeScript, not SQL.** `listCategoryRelatedCandidates()` returns
  candidates unordered on purpose so the whole contract — traversal across categories and order
  within one — is pinned by domain tests with no database.
- **Intra-row CHECK constraints only.** The migration adds `productId <> relatedProductId` and
  `position >= 0`. It deliberately adds nothing that pretends to cover top-level exclusivity, which
  §4.5 records as application-enforced and audited.

### Not included, and why

- **Storefront and admin UI.** `listConfiguredCategoryProducts()` and
  `listConfiguredHomepageFeaturedProducts()` exist as the runtime seam, but no page consumes them
  yet: the category route is still the F-series placeholder, and rendering those grids is F4a/F7d,
  not M2/M3b. M3a *is* wired — the PDP now resolves related products through this contract.
- **A membership admin page.** The §4.6 write boundary ships and is tested; the form that calls it
  is admin UI work in the same F/M series as the rest.

## Status of G4

G4 is **architecture-complete**: one canonical category authority now exists, with stable identity,
explicit hierarchy, deterministic path resolution, a website-owned membership shape, a one-top-level
invariant enforced at a single validated write boundary and backed by an integrity check,
child-to-parent projection without derived rows, and a single query contract that PLP order,
category media and related products all key to.

M2, M3a, M3b, F4a, F7d and category/mega-menu editorial media are unblocked **at the architecture
level** and remain behind their existing plan dependencies and Checkpoint B for the migrations
listed above. G5 is untouched by this ADR.