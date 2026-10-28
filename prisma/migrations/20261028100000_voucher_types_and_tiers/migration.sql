-- Voucher types and tiers (ADR 0020, extends SPEC-VOUCHER-001 / ADR 0018 / ADR 0019).
-- A MERCHANDISE voucher can belong to a TYPE; at most one voucher per SLOT may be held and redeemed per attempt/order, where a
-- slot is `SHIPPING_FREE`, `MERCHANDISE` (a voucher with no type: exactly v1) or `MERCHANDISE:<typeId>`.
-- Additive: one new table, new nullable/defaulted columns, two unique keys that move from "per kind" to "per slot", and the two
-- ledger guards re-created with the slot added. Nothing is read or written until LA_VOUCHER_ENABLED is on; with no typed
-- campaign every slot equals the kind and the behaviour is v1's.
--
-- Rollback (safe only while no accepted order has two merchandise redemptions and no typed campaign is live):
--   DROP TRIGGER "VoucherCampaign_type_guard" ON "VoucherCampaign"; DROP TRIGGER "VoucherCampaign_code_namespace" ON "VoucherCampaign";
--   DROP TRIGGER "VoucherType_guard" ON "VoucherType"; DROP TRIGGER "VoucherType_code_namespace" ON "VoucherType";
--   DROP TRIGGER "VoucherHold_0_slot" ON "VoucherHold"; DROP TRIGGER "VoucherRedemption_0_slot" ON "VoucherRedemption";
--   DROP INDEX "VoucherHold_live_attempt_slot_key"; CREATE UNIQUE INDEX "VoucherHold_live_attempt_kind_key" ON "VoucherHold"("attemptKey", "kind") WHERE "state" = 'HELD';
--   DROP INDEX "VoucherRedemption_orderId_slot_key"; CREATE UNIQUE INDEX "VoucherRedemption_orderId_kind_key" ON "VoucherRedemption"("orderId", "kind");
--   ALTER TABLE "VoucherHold" DROP COLUMN "slot"; ALTER TABLE "VoucherRedemption" DROP COLUMN "slot";
--   ALTER TABLE "CartVoucherSelection" DROP COLUMN "typeSelections";
--   ALTER TABLE "VoucherCampaign" DROP CONSTRAINT "VoucherCampaign_issuance_check", DROP COLUMN "typeId";
--   -- then re-add the v1 "VoucherCampaign_issuance_check" and the v1 guard bodies from migration 20261025100000, and
--   DROP TABLE "VoucherType"; DROP FUNCTION "voucher_campaign_type_guard"(), "voucher_type_guard"(), "voucher_code_namespace_guard"(),
--     "voucher_slot_default"(), "voucher_redemption_slot_default"();

-- ---------------------------------------------------------------------------------------------------
-- The type: a name, its place in the stack, and its distribution. A CODE type owns ONE code for all its tiers.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "VoucherType" (
  "id" TEXT NOT NULL,
  "pancakeShopId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "issuance" "VoucherIssuance" NOT NULL,
  "visibility" "VoucherVisibility" NOT NULL,
  "code" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "VoucherType_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherType_values_check" CHECK (
    "pancakeShopId" > 0 AND length(btrim("name")) BETWEEN 1 AND 120 AND "priority" BETWEEN 1 AND 1000
    AND "id" ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  CONSTRAINT "VoucherType_issuance_check" CHECK (
    ("issuance" = 'AUTO' AND "code" IS NULL AND "visibility" = 'PUBLIC')
    OR ("issuance" = 'CODE' AND "code" ~ '^[A-Z0-9_-]{3,32}$')
  )
);
CREATE UNIQUE INDEX "VoucherType_pancakeShopId_code_key" ON "VoucherType"("pancakeShopId", "code");
CREATE INDEX "VoucherType_pancakeShopId_priority_idx" ON "VoucherType"("pancakeShopId", "priority");

-- ---------------------------------------------------------------------------------------------------
-- A tier is a campaign with a type. The tier copies issuance/visibility from its type (kept equal by trigger) and leaves its
-- own code empty: the type owns the code.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "VoucherCampaign" ADD COLUMN "typeId" TEXT;
ALTER TABLE "VoucherCampaign" ADD CONSTRAINT "VoucherCampaign_typeId_fkey"
  FOREIGN KEY ("typeId") REFERENCES "VoucherType"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "VoucherCampaign_typeId_idx" ON "VoucherCampaign"("typeId");
ALTER TABLE "VoucherCampaign"
  DROP CONSTRAINT "VoucherCampaign_issuance_check",
  ADD CONSTRAINT "VoucherCampaign_issuance_check" CHECK (
    ("typeId" IS NULL AND (
      ("issuance" = 'AUTO' AND "code" IS NULL AND "visibility" = 'PUBLIC')
      OR ("issuance" = 'CODE' AND "code" ~ '^[A-Z0-9_-]{3,32}$')
    ))
    OR ("typeId" IS NOT NULL AND "kind" = 'MERCHANDISE' AND "code" IS NULL
      AND (("issuance" = 'AUTO' AND "visibility" = 'PUBLIC') OR "issuance" = 'CODE'))
  );

-- A tier belongs to a type of its own shop, with that type's issuance and visibility, and never changes type: a live hold's
-- slot names the type, so moving a tier would silently move held entitlements between slots.
CREATE FUNCTION "voucher_campaign_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."typeId" IS DISTINCT FROM OLD."typeId" THEN
    RAISE EXCEPTION 'A voucher tier cannot change type';
  END IF;
  IF NEW."typeId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT t."pancakeShopId", t."issuance", t."visibility" INTO parent FROM "VoucherType" t WHERE t."id" = NEW."typeId";
  IF NOT FOUND OR parent."pancakeShopId" <> NEW."pancakeShopId" THEN
    RAISE EXCEPTION 'A voucher tier must belong to a type of the same shop';
  END IF;
  IF parent."issuance" <> NEW."issuance" OR parent."visibility" <> NEW."visibility" THEN
    RAISE EXCEPTION 'A voucher tier has the issuance and visibility of its type';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherCampaign_type_guard" BEFORE INSERT OR UPDATE ON "VoucherCampaign"
FOR EACH ROW EXECUTE FUNCTION "voucher_campaign_type_guard"();

-- A type's distribution is fixed while it has tiers: its tiers carry copies of it.
CREATE FUNCTION "voucher_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."issuance" <> OLD."issuance" OR NEW."visibility" <> OLD."visibility" OR NEW."pancakeShopId" <> OLD."pancakeShopId")
     AND EXISTS (SELECT 1 FROM "VoucherCampaign" c WHERE c."typeId" = OLD."id") THEN
    RAISE EXCEPTION 'A voucher type with tiers keeps its shop, issuance and visibility';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherType_guard" BEFORE UPDATE ON "VoucherType"
FOR EACH ROW EXECUTE FUNCTION "voucher_type_guard"();

-- One code namespace per shop: a code belongs to either a campaign or a type, never both, so a lookup is unambiguous.
CREATE FUNCTION "voucher_code_namespace_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."code" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'VoucherType' THEN
    IF EXISTS (SELECT 1 FROM "VoucherCampaign" c WHERE c."pancakeShopId" = NEW."pancakeShopId" AND c."code" = NEW."code") THEN
      RAISE EXCEPTION 'A voucher code is already used by a campaign of this shop';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM "VoucherType" t WHERE t."pancakeShopId" = NEW."pancakeShopId" AND t."code" = NEW."code") THEN
    RAISE EXCEPTION 'A voucher code is already used by a type of this shop';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherType_code_namespace" BEFORE INSERT OR UPDATE OF "code" ON "VoucherType"
FOR EACH ROW EXECUTE FUNCTION "voucher_code_namespace_guard"();
CREATE TRIGGER "VoucherCampaign_code_namespace" BEFORE INSERT OR UPDATE OF "code" ON "VoucherCampaign"
FOR EACH ROW EXECUTE FUNCTION "voucher_code_namespace_guard"();

-- ---------------------------------------------------------------------------------------------------
-- Hold and redemption: the unit of "only one" moves from the kind to the slot. A writer that does not know about slots (older
-- code, fixtures) inserts '' and gets the slot of its campaign; a wrong slot is refused.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "VoucherHold" ADD COLUMN "slot" TEXT NOT NULL DEFAULT '';
ALTER TABLE "VoucherRedemption" ADD COLUMN "slot" TEXT NOT NULL DEFAULT '';
UPDATE "VoucherHold" SET "slot" = "kind"::text WHERE "slot" = '';
UPDATE "VoucherRedemption" SET "slot" = "kind"::text WHERE "slot" = '';
ALTER TABLE "VoucherHold" ADD CONSTRAINT "VoucherHold_slot_check" CHECK (
  ("kind" = 'SHIPPING_FREE' AND "slot" = 'SHIPPING_FREE')
  OR ("kind" = 'MERCHANDISE' AND ("slot" = 'MERCHANDISE' OR "slot" ~ '^MERCHANDISE:[A-Za-z0-9_-]{1,64}$'))
);
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_slot_check" CHECK (
  ("kind" = 'SHIPPING_FREE' AND "slot" = 'SHIPPING_FREE')
  OR ("kind" = 'MERCHANDISE' AND ("slot" = 'MERCHANDISE' OR "slot" ~ '^MERCHANDISE:[A-Za-z0-9_-]{1,64}$'))
);

DROP INDEX "VoucherHold_live_attempt_kind_key";
CREATE UNIQUE INDEX "VoucherHold_live_attempt_slot_key" ON "VoucherHold"("attemptKey", "slot") WHERE "state" = 'HELD';
CREATE INDEX "VoucherHold_attemptKey_slot_state_idx" ON "VoucherHold"("attemptKey", "slot", "state");
DROP INDEX "VoucherRedemption_orderId_kind_key";
CREATE UNIQUE INDEX "VoucherRedemption_orderId_slot_key" ON "VoucherRedemption"("orderId", "slot");

CREATE FUNCTION "voucher_slot_default"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  campaign RECORD;
  expected TEXT;
BEGIN
  SELECT c."kind", c."typeId" INTO campaign FROM "VoucherCampaign" c WHERE c."id" = NEW."campaignId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A voucher hold needs a campaign';
  END IF;
  expected := CASE
    WHEN campaign."kind" = 'SHIPPING_FREE' THEN 'SHIPPING_FREE'
    WHEN campaign."typeId" IS NULL THEN 'MERCHANDISE'
    ELSE 'MERCHANDISE:' || campaign."typeId"
  END;
  IF NEW."slot" = '' THEN
    NEW."slot" := expected;
  ELSIF NEW."slot" <> expected THEN
    RAISE EXCEPTION 'A voucher hold slot must be the slot of its campaign';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherHold_0_slot" BEFORE INSERT ON "VoucherHold"
FOR EACH ROW EXECUTE FUNCTION "voucher_slot_default"();

CREATE FUNCTION "voucher_redemption_slot_default"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held_slot TEXT;
BEGIN
  SELECT h."slot" INTO held_slot FROM "VoucherHold" h WHERE h."id" = NEW."holdId";
  IF held_slot IS NULL THEN
    RAISE EXCEPTION 'A voucher redemption needs its hold';
  END IF;
  IF NEW."slot" = '' THEN
    NEW."slot" := held_slot;
  ELSIF NEW."slot" <> held_slot THEN
    RAISE EXCEPTION 'A voucher redemption slot must be the slot of its hold';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherRedemption_0_slot" BEFORE INSERT ON "VoucherRedemption"
FOR EACH ROW EXECUTE FUNCTION "voucher_redemption_slot_default"();

-- The ledger guards of migration 20261025100000, with the slot frozen like every other identity column.
CREATE OR REPLACE FUNCTION "voucher_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" IN ('HELD', 'CONSUMED') THEN
      RAISE EXCEPTION 'A live or consumed voucher hold cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."campaignId" <> OLD."campaignId" OR NEW."campaignRevision" <> OLD."campaignRevision"
     OR NEW."pancakeShopId" <> OLD."pancakeShopId" OR NEW."kind" <> OLD."kind" OR NEW."slot" <> OLD."slot"
     OR NEW."attemptKey" <> OLD."attemptKey" OR NEW."quoteDigest" <> OLD."quoteDigest"
     OR NEW."paidRevision" <> OLD."paidRevision" OR NEW."heldDiscountVnd" <> OLD."heldDiscountVnd"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A voucher hold keeps its identity, amount and expiry for its whole life';
  END IF;
  IF OLD."state" <> 'HELD' THEN
    IF ROW(NEW."state", NEW."consumedAt", NEW."releasedAt", NEW."orderId")
       IS DISTINCT FROM ROW(OLD."state", OLD."consumedAt", OLD."releasedAt", OLD."orderId") THEN
      RAISE EXCEPTION 'A settled voucher hold cannot change state';
    END IF;
  ELSIF NEW."state" = 'CONSUMED' AND clock_timestamp() >= OLD."expiresAt" THEN
    RAISE EXCEPTION 'An expired voucher hold cannot be consumed';
  ELSIF NEW."state" = 'EXPIRED' AND clock_timestamp() < OLD."expiresAt" THEN
    RAISE EXCEPTION 'A voucher hold cannot expire before its expiry';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "voucher_redemption_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A voucher redemption is a ledger entry and cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT h."state", h."orderId", h."kind", h."slot", h."campaignId", h."campaignRevision", h."heldDiscountVnd"
      INTO held FROM "VoucherHold" h WHERE h."id" = NEW."holdId";
    IF NOT FOUND OR held."state" <> 'CONSUMED' OR held."orderId" IS DISTINCT FROM NEW."orderId"
       OR held."kind" <> NEW."kind" OR held."slot" <> NEW."slot" OR held."campaignId" <> NEW."campaignId"
       OR held."campaignRevision" <> NEW."campaignRevision" OR held."heldDiscountVnd" <> NEW."amountVnd" THEN
      RAISE EXCEPTION 'A voucher redemption must match a consumed hold of the same order, kind, slot, campaign and amount';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "OrderAcceptance" a WHERE a."orderId" = NEW."orderId") THEN
      RAISE EXCEPTION 'A voucher can be redeemed only by a website-accepted order';
    END IF;
    IF NEW."refundedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A voucher redemption cannot be created already refunded';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."campaignId" <> OLD."campaignId" OR NEW."campaignRevision" <> OLD."campaignRevision"
     OR NEW."kind" <> OLD."kind" OR NEW."slot" <> OLD."slot" OR NEW."orderId" <> OLD."orderId" OR NEW."holdId" <> OLD."holdId"
     OR NEW."amountVnd" <> OLD."amountVnd" OR NEW."websiteAcceptedAt" <> OLD."websiteAcceptedAt"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A voucher redemption keeps its identity and amount';
  END IF;
  IF OLD."refundedAt" IS NOT NULL
     AND ROW(NEW."refundedAt", NEW."refundReason", NEW."refundEvidence")
       IS DISTINCT FROM ROW(OLD."refundedAt", OLD."refundReason", OLD."refundEvidence") THEN
    RAISE EXCEPTION 'A voucher refund is final';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Cart-bound selection of typed slots: { "<typeId>": { "mode": "AUTO"|"MANUAL", "voucherId": string|null, "unlocked": boolean } }.
-- The untyped slot keeps using the v1 columns. Intent only; ids are not foreign keys, like the v1 columns.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "CartVoucherSelection" ADD COLUMN "typeSelections" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "CartVoucherSelection" ADD CONSTRAINT "CartVoucherSelection_typeSelections_check" CHECK (
  jsonb_typeof("typeSelections") = 'object' AND pg_column_size("typeSelections") <= 8192
);
