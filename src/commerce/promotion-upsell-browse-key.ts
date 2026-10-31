import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.ts";

/**
 * What a cached browse list silently depends on besides the paid lines (`paidCartKey`):
 * - the promotion pricing revision, advanced by every effective campaign edit, enable or disable;
 * - the cart's gift choices, which a "+1" candidate must preserve but which do not advance `paidRevision`;
 * - the next time a campaign starts or ends, which advances nothing (no write happens at `startsAt`/`endsAt`).
 * Reading these is two single-cart/row queries; the boundary is read once per computed (not served) list.
 */
type KeyReader = Pick<Prisma.TransactionClient, "promotionPricingRevision" | "cartGiftSelection">;

export async function readBrowseKeyInputs(reader: KeyReader, cartId: string): Promise<{ promotionRevision: bigint; selectionDigest: string }> {
  const [promotion, selections] = await Promise.all([
    reader.promotionPricingRevision.findUnique({ where: { id: "current" }, select: { revision: true } }),
    reader.cartGiftSelection.findMany({
      where: { cartId }, orderBy: [{ campaignId: "asc" }, { variantId: "asc" }], take: 200,
      select: { campaignId: true, variantId: true, quantity: true, campaignRevision: true },
    }),
  ]);
  if (!promotion) throw new Error("Promotion pricing revision row is missing");
  const digest = createHash("sha256").update(JSON.stringify(selections.map((s) => [s.campaignId, s.variantId, s.quantity, s.campaignRevision]))).digest("base64url").slice(0, 22);
  return { promotionRevision: promotion.revision, selectionDigest: digest };
}

/**
 * Epoch ms of the earliest future start or end among enabled campaigns that can change a cart quote
 * (gift/tier, flash-sale price promotions, shipping), or null. A list verified now is only known true until then.
 *
 * Time zone: GiftQuantityCampaign/PromotionCampaign hold `timestamp(3)` (a UTC wall clock, which is how Prisma writes
 * DateTime) while ShippingPromotionCampaign holds `timestamptz(3)`. A UNION of the two is converted in the session
 * TimeZone, and a driver can misread the result the same way, so nothing here depends on the session or the driver:
 * the `timestamp` columns are declared UTC with AT TIME ZONE 'UTC', "now" travels as epoch milliseconds, and the result
 * leaves as epoch milliseconds. (Other raw SQL in this codebase assumes a UTC session; this does not need to.)
 */
export async function nextCampaignBoundaryMs(tx: Pick<Prisma.TransactionClient, "$queryRaw">, now: Date): Promise<number | null> {
  const nowMs = now.getTime();
  const rows = await tx.$queryRaw<{ next: bigint | number | null }[]>`
    WITH "nowAt" AS (SELECT to_timestamp(${nowMs}::double precision / 1000) AS "t"),
    "boundary" AS (
      SELECT "startsAt" AT TIME ZONE 'UTC' AS "t" FROM "GiftQuantityCampaign" WHERE "isEnabled"
      UNION ALL SELECT "endsAt" AT TIME ZONE 'UTC' FROM "GiftQuantityCampaign" WHERE "isEnabled"
      UNION ALL SELECT "startsAt" AT TIME ZONE 'UTC' FROM "PromotionCampaign" WHERE "isEnabled"
      UNION ALL SELECT "endsAt" AT TIME ZONE 'UTC' FROM "PromotionCampaign" WHERE "isEnabled"
      UNION ALL SELECT "startsAt" FROM "ShippingPromotionCampaign" WHERE "isEnabled"
      UNION ALL SELECT "endsAt" FROM "ShippingPromotionCampaign" WHERE "isEnabled"
    )
    SELECT (extract(epoch FROM min(b."t")) * 1000)::bigint AS "next"
    FROM "boundary" b, "nowAt" n WHERE b."t" > n."t"`;
  const next = rows[0]?.next;
  return next === null || next === undefined ? null : Number(next);
}
