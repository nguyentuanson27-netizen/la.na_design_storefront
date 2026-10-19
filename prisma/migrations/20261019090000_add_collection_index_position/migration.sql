-- Merchandiser-controlled order of the /collections index (lowest first; NULL sorts last)
ALTER TABLE "CollectionDefinition" ADD COLUMN "indexPosition" INTEGER;
