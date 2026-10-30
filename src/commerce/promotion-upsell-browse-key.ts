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
 */
export async function nextCampaignBoundaryMs(tx: Pick<Prisma.TransactionClient, "$queryRaw">, now: Date): Promise<number | null> {
  const rows = await tx.$queryRaw<{ next: Date | null }[]>`
    SELECT min(b."t") AS "next" FROM (
      SELECT "startsAt" AS "t" FROM "GiftQuantityCampaign" WHERE "isEnabled" AND "startsAt" > ${now}
      UNION ALL SELECT "endsAt" FROM "GiftQuantityCampaign" WHERE "isEnabled" AND "endsAt" > ${now}
      UNION ALL SELECT "startsAt" FROM "PromotionCampaign" WHERE "isEnabled" AND "startsAt" > ${now}
      UNION ALL SELECT "endsAt" FROM "PromotionCampaign" WHERE "isEnabled" AND "endsAt" > ${now}
      UNION ALL SELECT "startsAt" FROM "ShippingPromotionCampaign" WHERE "isEnabled" AND "startsAt" > ${now}
      UNION ALL SELECT "endsAt" FROM "ShippingPromotionCampaign" WHERE "isEnabled" AND "endsAt" > ${now}
    ) b`;
  const next = rows[0]?.next;
  return next ? next.getTime() : null;
}
