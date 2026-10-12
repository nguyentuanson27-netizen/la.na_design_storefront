-- Owner-managed new arrivals: selection and ranking are independent of catalog mirror recency.
-- Intentionally empty on deployment: there must be no automatic newest-products fallback.
CREATE TABLE "NewArrivalProduct" (
    "productId" TEXT NOT NULL,
    "pancakeShopId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "NewArrivalProduct_pkey" PRIMARY KEY ("productId")
);

CREATE UNIQUE INDEX "NewArrivalProduct_pancakeShopId_position_key" ON "NewArrivalProduct"("pancakeShopId", "position");

ALTER TABLE "NewArrivalProduct"
    ADD CONSTRAINT "NewArrivalProduct_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NewArrivalProduct"
    ADD CONSTRAINT "NewArrivalProduct_position_non_negative" CHECK ("position" >= 0);
