-- Product editorial: fabric composition and construction notes.
--
-- Both are additive and nullable/defaulted, so existing rows stay valid and a product that has not
-- been written up yet simply has nothing to show. `craftDetails` is an array rather than a single
-- text column because the storefront renders the notes as a list, and splitting a paragraph back
-- into bullets in the reader is how that formatting gets lost.
ALTER TABLE "ProductContent" ADD COLUMN "material" TEXT;
ALTER TABLE "ProductContent" ADD COLUMN "craftDetails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
