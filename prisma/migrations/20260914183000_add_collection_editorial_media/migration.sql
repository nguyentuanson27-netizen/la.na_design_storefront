-- Collection editorial media.
--
-- The collection's story stays `description`; no separate story column is introduced. What is added
-- is the media that story is told with, plus the slugs a merchandiser pins to the top of the grid.
--
-- URLs are stored as written and validated on read against the reviewed Pancake CDN contract, so a
-- row that predates the validator, or one an admin fills in by hand, cannot put an untrusted host in
-- front of a shopper.
ALTER TABLE "CollectionDefinition" ADD COLUMN "heroImageUrl" TEXT;
ALTER TABLE "CollectionDefinition" ADD COLUMN "galleryImageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CollectionDefinition" ADD COLUMN "videoSrcUrl" TEXT;
ALTER TABLE "CollectionDefinition" ADD COLUMN "videoPosterUrl" TEXT;
ALTER TABLE "CollectionDefinition" ADD COLUMN "featuredProductSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
