CREATE TYPE "PancakeVideoSyncState" AS ENUM ('UNKNOWN', 'READY', 'NONE', 'CONFLICT', 'UNSUPPORTED');
ALTER TABLE "ProductMirror"
  ADD COLUMN "pancakeVideoUrl" TEXT,
  ADD COLUMN "pancakeVideoSyncState" "PancakeVideoSyncState" NOT NULL DEFAULT 'UNKNOWN';
