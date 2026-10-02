-- Pancake product names are keyed as "<name> <product code>" ("Set váy Diệu Liên Hoa SV605").
-- Catalog sync now mirrors the name without the code and keeps the code here so storefront and
-- admin search still find a product by it. Existing rows still carry the code inside "name" until
-- their next sync rewrites both columns, so search keeps working across the rollout.
ALTER TABLE "ProductMirror" ADD COLUMN "productCode" TEXT;
