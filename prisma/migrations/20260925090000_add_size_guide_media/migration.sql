-- Admin-managed size-guide artwork, replacing the images bundled under public/brand/size-guides.
CREATE TABLE "SizeGuideMedia" (
    "guideId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SizeGuideMedia_pkey" PRIMARY KEY ("guideId")
);
