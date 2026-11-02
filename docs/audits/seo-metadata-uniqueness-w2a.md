# W2a — PDP metadata uniqueness replacement contract

Owning source: `docs/audits/seo-geo-audit.md` finding **W2**, planning step **P1/W2a**.
Master-plan unit: **U4**. Consumer: **U29 / W2b**.

Status: **STILL BLOCKED for the slug/path removal; one component of exit path 1 has landed.**
The owner decision (B5) exists, and U29 implemented its **application-level** enforcement in the
admin publish path. Exit path 1's **database-level** enforcement and its separate fallback-copy
proof are **not** met, so the slug/path discriminator stays. See
[U29 closure](#u29-closure-what-the-enforcement-actually-does) for exactly what changed and what
did not, and [Verdict](#verdict) for the original wording.

## What the current contract does

`src/seo/product-metadata.ts` builds every PDP title and description from website-owned copy and
then appends the canonical slug:

```text
title:       `${seoTitle ?? name} — ${slug}`
description: `${seoDescription} — /shop/${slug}.`
             `Thông tin sản phẩm ${name} tại LA Clothing — /shop/${slug}.`   (fallback)
```

That trailing slug and path read poorly in a SERP, which is what W2 flags. It is also the only thing
keeping two PDPs distinguishable when their copy is otherwise identical, which is why W2b may not
remove it before a replacement is proven.

## Inventory of the existing uniqueness verification

| Verification | Location | What it proves | Runs in CI |
|---|---|---|---|
| Distinct-slug published copy stays unique | `tests/domain/product-metadata.test.ts` — "published SEO copy remains unique across distinct canonical product slugs" | Two products with the same published `seoTitle`/`seoDescription` still get different titles and descriptions | Yes (`pnpm test`) |
| Distinct-slug fallback copy stays unique | `tests/domain/product-metadata.test.ts` — "fallback metadata stays factual and unique for distinct slugs sharing the same product name" | Two products with the same `name` and no published copy still get different titles and descriptions | Yes (`pnpm test`) |
| Rendered HTML keeps both classes unique | `scripts/product-metadata-http-smoke.ts` (`publishedDuplicate*`, `fallback*` fixtures) | The same two classes stay unique in the real `<title>`/`<meta name="description">` of a Next response | Yes — see [How the HTTP smoke reaches CI](#how-the-http-smoke-reaches-ci) |
| Collisions are reachable through the deployed schema | `tests/database/product-metadata-uniqueness.test.ts` (added by U4) | Neither `ProductContent.seoTitle`/`seoDescription` nor `ProductMirror.name` is constrained unique, so both collision classes are real data states | Yes (`pnpm test:db`) |
| The replacement contract's collision report | `tests/domain/product-metadata-uniqueness.test.ts` (added by U4) | The slug-free candidate copy collides for both classes and is deterministic | Yes (`pnpm test`) |

### How the HTTP smoke reaches CI

No workflow step or npm script names `scripts/product-metadata-http-smoke.ts`, which makes it easy
to assume it is unwired. It is not. The chain is:

```text
.github/workflows/ci.yml  → job `verify` → step "Domain tests" → pnpm test
package.json              → "test": node --test tests/domain/*.test.ts tests/integrations/*.test.ts
tests/integrations/product-slug-http.test.ts
                          → await import("../../scripts/product-metadata-http-smoke.ts")
```

The import boots a real Next server, seeds PostgreSQL and asserts against real HTTP responses, so
the uniqueness contract is gated at the rendered-HTML level on every pull request.

## When two PDPs collide

Two products produce identical slug-free metadata when **both** the title and the description match.
Two independent data states reach that:

1. **Duplicate published copy.** `ProductContent.seoTitle` and `seoDescription` are plain nullable
   columns with no unique index and no cross-product validation. Two editors can publish the same
   sentences, and the migration history has never constrained them.
2. **Duplicate fallback copy.** With no published copy the title is `ProductMirror.name` and the
   description is generated from it. `ProductMirror.name` is mirrored from Pancake and is not
   unique — only `pancakeProductId` and `slug` are.

A shared title alone is *not* a collision: the description still separates the two pages. The
contract therefore keys on the pair.

## The replacement contract implemented by U4

`src/seo/product-metadata-uniqueness.ts` is validation and evidence only. It does not change what a
PDP emits; `buildStorefrontProductMetadata` remains the single metadata authority.

- `buildSlugFreeProductCopy(product)` — the exact copy a slug-free contract would emit: today's
  published-or-fallback sentences with the slug and `/shop/<slug>` path removed and nothing invented
  in their place.
- `findProductMetadataCollisions(products)` — the deterministic collision groups under that copy.
  Groups and their slugs are sorted, so the same catalog always yields the same report.
- `evaluateProductMetadataUniqueness(products)` — the gate: `safeToRemoveSlugDiscriminator` is true
  only when there is no collision group at all. A partially collision-free catalog is not a licence
  to drop the discriminator for the rest of it.

## U29 closure: what the enforcement actually does

This section is the current status of the audit's first exit path. The **Verdict** and **Open
semantic question** sections below are kept as the record of what was true when the audit was
written; where they disagree with this section, this section is authoritative.

**The owner settled the semantic question.** `docs/specs/la-clothing-owner-approved-facts-and-decisions.md`
§8 resolves B5 as **pair-level**, not per-field: two products may share a `seoTitle` as long as their
`seoDescription` differs. A draft may be missing either field or duplicate another product's copy;
the move to `PUBLISHED` requires both fields and refuses a pair another published product holds.
That decision predates this work — U29 implements it, it does not make it.

### Exit path 1 scorecard — two of four components met

Exit path 1 above is not a single condition. Read literally, it requires published
`seoTitle`/`seoDescription` to become unique across products **"enforced in the database and in the
admin publish path"**, *and* the fallback copy for products without published copy to be
**separately proven collision-free** — plus the owner decision about what happens on collision.

| Component of exit path 1 | State after U29 |
|---|---|
| Owner decision on publish-time collision behaviour | **MET** — B5, resolved before this work |
| Enforced in the **admin publish path** | **MET** — see below; tested at the domain, database and real-browser levels |
| Enforced in the **database** | **NOT MET** — no constraint or index owns the invariant; see [Where the invariant actually lives](#where-the-invariant-actually-lives) |
| Fallback copy separately proven collision-free | **NOT MET** — untouched by U29; the name-derived fallback class is outside the published-pair domain entirely |

Two of the four are outstanding, so **exit path 1 is not taken** and the slug stays. Nothing in U29
changes the acceptance condition; narrowing it to the admin-publish-path half would be inventing a
reconciliation this repository's owning sources never made. Closing the database component needs
either a constraint that owns the invariant, or an explicit owner/source-contract decision that
application-level enforcement is accepted in its place. **Neither exists**, and U29 does not assert
one.

### The equality rule

`normalizeMetadataText` in `src/seo/product-metadata-uniqueness.ts` is the only place text is
normalized before comparison, and everything else — the collision report, the publish gate, the
admin warning and the SQL predicate — is defined in terms of it:

1. **Unicode NFC.** Vietnamese copy arrives precomposed or combining depending on the operator's
   input method; `"\u00c1o"` and `"A\u0301o"` are the same text by Unicode's own definition, and
   treating them as different strings would publish two reader-identical PDPs.
2. **`String.prototype.trim()`**, the JS whitespace set rather than Postgres' ASCII-only `BTRIM`.
   This is the presence reading the editor's `parseTextField` and acceptance's `hasText` already
   use, so a value is present here exactly when it is present there.

Case folding, internal whitespace collapsing and any similarity scoring are deliberately **out**.
B5 approves uniqueness of the pair; a looser rule would refuse copy the owner never banned, and
widening it is an owner decision rather than an implementation one. `findProductMetadataCollisions`
now keys on the same helper, so this audit's own evidence report and the live publish gate cannot
drift apart. The database predicate mirrors the same two steps in the same order
(`REGEXP_REPLACE(NORMALIZE(col, NFC), <JS trim class>, '', 'g')`), reusing the trim authority that
already backs the admin `missing-seo` health filter.

### Where it is enforced

At the persistence boundary, not in the browser and not only in the service:

| Path | Behaviour |
|---|---|
| Editor save (`createProductContentAdminService.update`) | An incomplete publish is refused before any round trip; the pair check runs inside the write. |
| `saveContent` | Re-checks completeness rather than trusting its caller, then checks the pair inside the transaction that writes the row. |
| Bulk status (`updateStatusesAtomically`) | On `PUBLISHED` only: refuses the whole batch if any member is incomplete, if two members claim one pair, or if a member collides with a published product outside the batch. |
| Any non-`PUBLISHED` write | No precondition at all — unpublishing can only shrink the published set. |

The published set is the only collision domain: a draft holding the same pair never blocks a
publish, and a product never collides with itself on re-save.

### Where the invariant actually lives

**The application owns it. The database does not.** This is the distinction exit path 1 draws, and
it is worth stating plainly rather than leaving to be inferred from the diff.

The invariant is a read-then-write, and the race was **reproduced** before anything was built for
it: two transactions under Read Committed both saw a conflict-free catalog and both wrote. Every
transaction that leaves a row `PUBLISHED` therefore takes one fixed `pg_advisory_xact_lock` before
its check. `tests/database/product-content-publish-uniqueness.test.ts` holds that lock from a second
client and proves the challenger cannot commit; removing the lock turns that test red.

That is a **cooperative protocol**, and its guarantee extends exactly as far as its participants.
Every write path this repository ships takes the lock, so no admin action — single or bulk,
concurrent or not — can produce a duplicate published pair. But the schema still carries no
constraint or index on the normalized published pair, so any writer that does not join the
protocol — a manual `psql` session, a future code path that forgets, a data migration, a restore —
can still create one. `tests/database/product-metadata-uniqueness.test.ts` continues to demonstrate
exactly that, and it is deliberately left passing rather than rewritten: the deployed schema really
does still permit duplicate published copy.

A unique index would move ownership to the database and close that component. It was **not** added
here, and the reason is a real one rather than a preference: it needs a migration the live catalog
is not guaranteed to survive, because nothing has ever constrained these columns and a legacy pair
of duplicate published rows would fail it on deploy — and rewriting or deleting that copy is an
owner decision nobody has made. Forcing that migration inside U29 would risk a failed production
deploy to close a documentation line.

So the component stays open, and closing it needs one of two things, neither of which U29 may
decide on its own:

1. a database constraint that owns the invariant, together with whatever owner decision covers
   legacy rows that would violate it; or
2. an explicit owner/source-contract decision that application-level enforcement is accepted in
   place of the database constraint W2a asks for.

### What the admin sees

The editor renders a persistent, non-blocking warning in the SEO section naming the published
product that already holds the pair. It is advice, not an alert: it takes no focus, announces
nothing, and disables no control. A draft with a colliding pair still saves. Submitting `PUBLISHED`
anyway is refused by the server with its own message, verified through the real form and Server
Action in `tests/a11y-runtime/admin-editor.spec.ts`.

### Still pending — why the slug stays

`buildStorefrontProductMetadata` is unchanged: PDP titles and descriptions still carry the slug and
`/shop/<slug>`.

Enforcement bounds *future* publishes. It does not retroactively make the existing catalog's
slug-free copy unique, and it says nothing about the fallback class at all — two products sharing a
`ProductMirror.name` with no published copy still produce identical slug-free sentences, and
`ProductMirror.name` is mirrored from Pancake and is not unique. Products published before this
change may also hold duplicate or incomplete copy that no gate has ever seen.

**Real-catalog verification is PENDING.** No production database or Pancake credential was available
in the execution context that implemented U29, and the repository has no approved read-only
collision audit script — `evaluateProductMetadataUniqueness` is currently reachable only from tests.
No result was invented in place of one. Removing the discriminator stays gated on all of:

1. the **database-level** component of exit path 1 — a constraint that owns the invariant, or an
   owner/source-contract decision accepting application-level enforcement in its place
   (see [Where the invariant actually lives](#where-the-invariant-actually-lives));
2. the **fallback copy** proven collision-free separately, which U29 did not touch;
3. running `evaluateProductMetadataUniqueness` over the real catalog through an approved read-only
   path and getting `safeToRemoveSlugDiscriminator: true`;
4. the owning source-of-truth approving the cleanup on that evidence.

## Discriminators considered and rejected

| Candidate | Why it was not used |
|---|---|
| Variant colour | The audit is explicit that colour is not unique per product without evidence. Products routinely share one colour, and a product with several colours has no single value to use. |
| Collection membership | `ProductContent.collectionSlugs` is an unconstrained array. A product may belong to zero or many collections, and two products commonly share one. |
| Size or size range | Shared across most of the catalog; carries no product identity. |
| `pancakeProductId` | Unique, but an opaque external identifier. Substituting it for the slug swaps one technical string for a less readable one, which does not address W2 at all. |
| A generated numeric suffix | Invents a fact the catalog does not have and produces copy no human approved. |

None of these yields a *human-readable* discriminator that is provably unique per product from data
the repository actually owns. Choosing one anyway would replace a real uniqueness contract with a
plausible-looking guess — exactly what the audit warns against.

## Verdict

> **Partly overtaken by events, but its conclusion stands.** This verdict records the state when the
> audit was written. The owner decision it asks for now exists (B5, pair-level), and U29 implemented
> the admin-publish-path component of exit path 1 — see
> [U29 closure](#u29-closure-what-the-enforcement-actually-does). Exit path 1's database-enforcement
> component and its separate fallback-copy proof are **not** met, so this verdict is **not**
> discharged: the slug/path copy stays.

**BLOCKED — U29 / W2b must not remove the slug/path copy on the current schema and data.**

The collision classes above are reachable states, not hypotheticals, and no trustworthy replacement
discriminator exists in the current schema. Until one of the following is true, the slug stays:

1. **A uniqueness constraint exists and is enforced.** Published `seoTitle`/`seoDescription` become
   unique across products — enforced in the database and in the admin publish path — and the
   fallback copy for products without published copy is separately proven collision-free. This
   requires an owner decision about what happens when an editor tries to publish copy that is
   already in use.
2. **An owner-approved, human-readable, per-product discriminator is added.** A real product-owned
   fact — not inferred from colour, collection or naming convention — that is guaranteed unique
   across the catalog.

Either path is a product/owner decision, not a coding one. When one lands, U29 re-runs
`evaluateProductMetadataUniqueness` over the real catalog, gets
`safeToRemoveSlugDiscriminator: true`, and only then changes `buildStorefrontProductMetadata` and
its regressions.

`BLOCKED — OWNER FACT/APPROVAL REQUIRED`: which of the two paths above to take, and the resulting
publish-time behaviour when copy collides.

**Owner:** repository owner / brand authority — the same human authority that owns ADR 0004's domain
decision. Not a coding decision, and not one a coding agent may infer from the catalog.

**Stop rule for U29 / W2b:** do not remove the slug/path discriminator, do not substitute a
discriminator of your own, and do not narrow the collision definition to make the verdict pass. If
U29 is reached before this decision exists, stop at U29 and report; every other unit that does not
depend on PDP metadata copy continues normally.

## Open semantic question for the owner: pair-level or per-field uniqueness — RESOLVED

> **Resolved by the owner as pair-level.** See
> `docs/specs/la-clothing-owner-approved-facts-and-decisions.md` §8 (B5) and
> [U29 closure](#u29-closure-what-the-enforcement-actually-does). The comparison below is kept
> because it records what the choice was between and what each option costs.

This had to be settled in the source contract before U29 implemented anything, rather than being
decided by accident inside that implementation.

The **current live contract** keeps title *and* description individually distinct, because the slug
discriminator is appended to both. The **replacement contract implemented here** treats a collision
as *both* matching, and explicitly treats a shared title with different descriptions as safe — a
test pins that.

Those are different guarantees, and the choice is a search-presentation judgement:

- **Pair-level** (what this module implements): two PDPs may share a title as long as their
  descriptions differ. Fewer copy changes forced on editors; two results in a SERP can carry the
  same headline.
- **Per-field**: title and description must each be unique across products. Stricter, closer to
  today's behaviour, and more work for editors on a catalog of near-identical garments.

Whichever is chosen, `findProductMetadataCollisions` changes in one place — its grouping key — and
the regressions follow. It belonged to the same owner decision above rather than being left implicit,
and that is how it was settled: pair-level, in the source contract, before U29 implemented it.

## 2026-11-02 addendum — the code replaces the slug where a product has one

**Decision source:** the owner's request to fix the PDP title that shows the raw slug
(`... — set-vay-sv605-01dd0809c343402da7d6`). This section is authoritative where it disagrees with
the paragraphs above.

Evidence gathered from the live catalog (275 products in the sitemap, titles and descriptions
fetched from the rendered pages):

- With the slug and path removed and nothing put in their place, exactly **one** pair of products
  collided (two "Set váy Bạch Lăng", codes SV9574 and SV9575), and 203 of 275 (74%) were on the
  generic fallback copy, so the slug really was carrying the uniqueness.
- Both colliding products have a Pancake product code, and the codes differ.

What changed in `src/seo/product-metadata.ts`:

| Product | Title | Description |
|---|---|---|
| Has a product code | `<seoTitle or name> <CODE>` (code omitted when the title already contains it) | published copy as written, or `Thông tin sản phẩm <name> (mã <CODE>) tại <brand>.` |
| No product code | unchanged: `<title> — <slug>` | unchanged: `... — /shop/<slug>.` |

A product with no code keeps the slug, so no product loses its discriminator. A trailing brand typed
into `seoTitle` (`... | La.na Design`) is removed, because the site title template appends it again.

Still true: the database does not enforce uniqueness of the published pair, and the product code is
not constrained unique in the schema (`ProductMirror.productCode` is a plain nullable column). Two
products sharing both a name and a code would collide; Pancake issues one code per product and the
live catalog has no such pair, but this is evidence, not a constraint.
