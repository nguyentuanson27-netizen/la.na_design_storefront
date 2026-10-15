-- Additive. Old application versions need not know this column. Every paid-line writer participates,
-- including direct SQL, cascades and future writers; quote-only/gift changes do not advance it.
ALTER TABLE "Cart" ADD COLUMN "paidRevision" BIGINT NOT NULL DEFAULT 0;
CREATE FUNCTION advance_cart_paid_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."cartId" = OLD."cartId"
      AND NEW."variantId" = OLD."variantId" AND NEW."quantity" = OLD."quantity"
      AND NEW."sourceProductSlug" IS NOT DISTINCT FROM OLD."sourceProductSlug" THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE "Cart" SET "paidRevision" = "paidRevision" + 1 WHERE "id" = OLD."cartId";
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."cartId" <> OLD."cartId") THEN
    UPDATE "Cart" SET "paidRevision" = "paidRevision" + 1 WHERE "id" = NEW."cartId";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER cart_paid_revision AFTER INSERT OR UPDATE OR DELETE ON "CartItem"
FOR EACH ROW EXECUTE FUNCTION advance_cart_paid_revision();
