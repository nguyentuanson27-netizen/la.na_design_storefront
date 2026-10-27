import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { readPublicVoucherCandidates } from "./voucher-candidate-repository.ts";
import { canGrantHonourableVoucherHolds } from "./voucher-gate.ts";
import { buildVoucherTeaser, type VoucherTeaserItem } from "./voucher-teaser.ts";

/** The PDP voucher teaser for one product; empty when the feature is OFF or on any failure (a teaser is optional). */
export async function readProductVoucherTeaser(input: Readonly<{ productId: string; now: Date }>): Promise<readonly VoucherTeaserItem[]> {
  try {
    const shopId = readPancakeShopId();
    // The same readiness as a hold: the PDP must not advertise what the cart and checkout will not offer.
    if (!canGrantHonourableVoucherHolds(shopId)) return [];
    const [campaigns, memberships] = await Promise.all([
      readPublicVoucherCandidates({ client: prisma, shopId, now: input.now }),
      prisma.productCategoryMembership.findMany({ where: { productId: input.productId }, select: { categoryKey: true }, take: 50 }),
    ]);
    if (campaigns.length === 0) return [];
    return buildVoucherTeaser({
      campaigns,
      product: { productId: input.productId, shopId: String(shopId), categoryKeys: memberships.map((row) => row.categoryKey) },
    });
  } catch {
    return [];
  }
}
