-- Bank transfer as a website payment method.
--
-- Additive: one new enum and one column with a COD default, so every existing order reads as COD and
-- an application rollback is not blocked by a column older code never writes. Rolling back is
-- `ALTER TABLE "OrderMirror" DROP COLUMN "paymentMethod"; DROP TYPE "PaymentMethod";`.
-- Nothing offers BANK_TRANSFER until BANK_TRANSFER_ENABLED is set.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD', 'BANK_TRANSFER');

-- AlterTable
ALTER TABLE "OrderMirror" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'COD';
