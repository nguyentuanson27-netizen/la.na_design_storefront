-- Gift & Quantity Promotions v1 (GQ11): the buyer's gift choices for a cart.
--
-- Additive: one new table, referenced by nothing that exists today. `CartItem` and its
-- `(cartId, variantId)` uniqueness are untouched, so a paid line and a gift line for the same
-- variant never collide and a gift can never be mistaken for paid quantity. The table stores a
-- choice only -- no price and no entitlement -- so a stale row can never become price authority.
-- Rolling back is `DROP TABLE "CartGiftSelection"`; nothing else depends on it. Nothing writes to
-- it until the gift selection mutation (GQ12), which is itself behind
-- LA_GIFT_QUANTITY_PROMOTIONS_ENABLED.

-- CreateTable
CREATE TABLE "CartGiftSelection" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignKind" "GiftQuantityCampaignKind" NOT NULL DEFAULT 'GIFT_ITEM',
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "campaignRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartGiftSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartGiftSelection_campaignId_idx" ON "CartGiftSelection"("campaignId");

-- CreateIndex
CREATE INDEX "CartGiftSelection_variantId_idx" ON "CartGiftSelection"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "CartGiftSelection_cartId_campaignId_variantId_key" ON "CartGiftSelection"("cartId", "campaignId", "variantId");

-- AddForeignKey
ALTER TABLE "CartGiftSelection" ADD CONSTRAINT "CartGiftSelection_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartGiftSelection" ADD CONSTRAINT "CartGiftSelection_campaignId_campaignKind_fkey" FOREIGN KEY ("campaignId", "campaignKind") REFERENCES "GiftQuantityCampaign"("id", "kind") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartGiftSelection" ADD CONSTRAINT "CartGiftSelection_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VariantMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounds. Every column is NOT NULL, so none of these can be skipped by a NULL.
-- Only a gift campaign can be referenced (the composite foreign key carries the kind).
ALTER TABLE "CartGiftSelection"
ADD CONSTRAINT "CartGiftSelection_kind_check" CHECK ("campaignKind" = 'GIFT_ITEM');

-- A single selection is bounded by the per-order technical cap (100), far below the 2^31 limit.
ALTER TABLE "CartGiftSelection"
ADD CONSTRAINT "CartGiftSelection_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100);

ALTER TABLE "CartGiftSelection"
ADD CONSTRAINT "CartGiftSelection_revision_check" CHECK ("campaignRevision" >= 1);
