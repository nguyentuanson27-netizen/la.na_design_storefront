-- Hand-entered customer reviews (admin), shown on the product page. Purely additive: new enums, one
-- new table; no existing table or column changes.
CREATE TYPE "ProductReviewSource" AS ENUM ('ZALO', 'MESSENGER', 'FACEBOOK', 'DIRECT');
CREATE TYPE "ProductReviewFit" AS ENUM ('SMALL', 'TRUE_TO_SIZE', 'LARGE');
CREATE TYPE "ProductReviewStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "ProductReview" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "ProductReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "rating" INTEGER NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT,
    "source" "ProductReviewSource" NOT NULL,
    "fit" "ProductReviewFit",
    "sizeLabel" TEXT,
    "colorLabel" TEXT,
    "heightCm" INTEGER,
    "weightKg" INTEGER,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orderPublicCode" TEXT,
    "shopReply" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "consentConfirmedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id"),
    -- The database, not only the form, refuses a star count outside 1..5 and implausible body facts.
    CONSTRAINT "ProductReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
    CONSTRAINT "ProductReview_heightCm_check" CHECK ("heightCm" IS NULL OR "heightCm" BETWEEN 100 AND 220),
    CONSTRAINT "ProductReview_weightKg_check" CHECK ("weightKg" IS NULL OR "weightKg" BETWEEN 25 AND 200),
    CONSTRAINT "ProductReview_imageUrls_check" CHECK (cardinality("imageUrls") <= 6)
);

CREATE INDEX "ProductReview_productId_status_reviewedAt_idx" ON "ProductReview"("productId", "status", "reviewedAt");

ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;
