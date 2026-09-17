-- Checkpoint B merchandising persistence (ADR 0013).
--
-- The five additive models the repository owner approved on 2026-09-16, recorded with provenance in
-- `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions. Additive
-- only: no existing column changes meaning, and there is NO BACKFILL. Category membership starts
-- empty and is admin-assigned, because deriving it from `ProductContent.collectionSlugs` or from
-- Pancake category would install the very namespace conflation ADR 0013 exists to separate.
--
-- Category identity is deliberately absent from this migration. The taxonomy lives in
-- `src/brand/category.config.ts` because a database row cannot create an App Router route; a
-- `CategoryDefinition` table would buy no flexibility while creating a second authority free to
-- disagree with the routes. So `categoryKey` here is a bare string with no foreign key, and its
-- integrity is maintained by the admin write boundary plus the audits in
-- `src/commerce/category-taxonomy.ts` (`findCategoryMembershipViolations`,
-- `findOrphanedCategoryKeys`) run as the ADR §4.8 pre-activation gate.

-- CreateTable
CREATE TABLE "HomepageFeaturedProduct" (
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "HomepageFeaturedProduct_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "ProductCategoryMembership" (
    "productId" TEXT NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategoryMembership_pkey" PRIMARY KEY ("productId","categoryKey")
);

-- CreateTable
CREATE TABLE "CategoryProductOrder" (
    "categoryKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "CategoryProductOrder_pkey" PRIMARY KEY ("categoryKey","productId")
);

-- CreateTable
CREATE TABLE "CategoryEditorialMedia" (
    "categoryKey" TEXT NOT NULL,
    "heroImageUrl" TEXT,
    "megaMenuImageUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryEditorialMedia_pkey" PRIMARY KEY ("categoryKey")
);

-- CreateTable
CREATE TABLE "RelatedProductOverride" (
    "productId" TEXT NOT NULL,
    "relatedProductId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "RelatedProductOverride_pkey" PRIMARY KEY ("productId","relatedProductId")
);

-- CreateIndex
CREATE UNIQUE INDEX "HomepageFeaturedProduct_position_key" ON "HomepageFeaturedProduct"("position");

-- CreateIndex
CREATE INDEX "ProductCategoryMembership_categoryKey_idx" ON "ProductCategoryMembership"("categoryKey");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryProductOrder_categoryKey_position_key" ON "CategoryProductOrder"("categoryKey", "position");

-- CreateIndex
CREATE INDEX "RelatedProductOverride_relatedProductId_idx" ON "RelatedProductOverride"("relatedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "RelatedProductOverride_productId_position_key" ON "RelatedProductOverride"("productId", "position");

-- AddForeignKey
ALTER TABLE "HomepageFeaturedProduct" ADD CONSTRAINT "HomepageFeaturedProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategoryMembership" ADD CONSTRAINT "ProductCategoryMembership_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryProductOrder" ADD CONSTRAINT "CategoryProductOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedProductOverride" ADD CONSTRAINT "RelatedProductOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedProductOverride" ADD CONSTRAINT "RelatedProductOverride_relatedProductId_fkey" FOREIGN KEY ("relatedProductId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Intra-row CHECK constraints.
--
-- Only intra-row predicates are added, because those are the ones the database can genuinely
-- enforce. The invariant this schema canNOT express is top-level exclusivity — "every one of a
-- product's categoryKeys derives to the same tree" — which spans rows and depends on a taxonomy
-- that is not in SQL. ADR 0013 §4.5 records why teaching the database the taxonomy was rejected,
-- and that invariant is enforced at the admin write boundary and audited instead. Nothing here
-- should be read as covering it.

-- Self-reference is intra-row, so it is enforced here as well as at the admin boundary
-- (ADR 0013 §7).
ALTER TABLE "RelatedProductOverride"
  ADD CONSTRAINT "RelatedProductOverride_no_self_reference"
  CHECK ("productId" <> "relatedProductId");

-- Positions are 0-based ranks. A negative rank has no meaning in any of the three ordered surfaces,
-- and the unique indexes above already prevent two rows sharing one slot.
ALTER TABLE "HomepageFeaturedProduct"
  ADD CONSTRAINT "HomepageFeaturedProduct_position_non_negative" CHECK ("position" >= 0);

ALTER TABLE "CategoryProductOrder"
  ADD CONSTRAINT "CategoryProductOrder_position_non_negative" CHECK ("position" >= 0);

ALTER TABLE "RelatedProductOverride"
  ADD CONSTRAINT "RelatedProductOverride_position_non_negative" CHECK ("position" >= 0);
