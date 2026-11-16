-- The order a product's colors, and so their photos, are shown in (admin-edited). Purely additive:
-- one new table, no existing table or column changes. A product with no row keeps the catalog order.
CREATE TABLE "ProductVariantColorOrder" (
    "productId" TEXT NOT NULL,
    "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariantColorOrder_pkey" PRIMARY KEY ("productId"),
    CONSTRAINT "ProductVariantColorOrder_colors_check" CHECK (cardinality("colors") <= 20)
);

ALTER TABLE "ProductVariantColorOrder"
    ADD CONSTRAINT "ProductVariantColorOrder_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SV612 (Set váy Bích Liên) leads with its pink photos; this is the one order that was set by hand
-- before the admin editor existed. A database without that product inserts nothing.
INSERT INTO "ProductVariantColorOrder" ("productId", "colors", "updatedAt")
SELECT "id", ARRAY['Hồng', 'Be'], CURRENT_TIMESTAMP
FROM "ProductMirror"
WHERE upper(btrim("productCode")) = 'SV612'
ON CONFLICT ("productId") DO NOTHING;
