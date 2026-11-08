-- A product's name and editorial copy in another language (admin-entered). The Vietnamese source
-- stays in "ProductMirror" (name) and "ProductContent" (editorial); a translation row only
-- overlays the fields it fills, so an empty field falls back to the Vietnamese. Purely additive: one
-- new table, no existing table or column changes.
CREATE TABLE "ProductTranslation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT,
    "editorialDescription" TEXT,
    "material" TEXT,
    "craftDetails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "careInstructions" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTranslation_pkey" PRIMARY KEY ("id"),
    -- The default language is not translated into itself; the database, not only the form, says so.
    CONSTRAINT "ProductTranslation_locale_check" CHECK ("locale" IN ('en'))
);

CREATE UNIQUE INDEX "ProductTranslation_productId_locale_key" ON "ProductTranslation"("productId", "locale");

ALTER TABLE "ProductTranslation" ADD CONSTRAINT "ProductTranslation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;
