import type { PrismaClient } from "../generated/prisma/client.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import {
  lockRevision,
  advanceRevision,
  PROMOTION_REVISION_ID,
  type AdminSessionCandidate,
  type Tx,
} from "./promotion-activation-service.ts";
import { readListPriceConfig } from "./list-price-config.ts";

export function readBasisDependentCampaigns(tx: Tx, now: Date) {
  return tx.promotionCampaign.findMany({
    where: {
      discountType: "PERCENTAGE",
      isEnabled: true,
      disabledAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
}
export async function freezeListPriceCampaignMutations(
  input: Readonly<{
    client: PrismaClient;
    session: AdminSessionCandidate;
    rollbackId: string;
    now: Date;
  }>,
) {
  const session = requireAdminSession(input.session);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.rollbackId))
    throw new Error("Invalid rollback identifier");
  return input.client.$transaction(async (tx) => {
    const revision = await lockRevision(tx);
    const row = await tx.promotionPricingRevision.findUniqueOrThrow({
      where: { id: PROMOTION_REVISION_ID },
    });
    if (
      row.campaignMutationFrozen &&
      row.campaignRollbackId !== input.rollbackId
    )
      throw new Error("Another rollback owns the freeze");
    await tx.promotionPricingRevision.update({
      where: { id: PROMOTION_REVISION_ID },
      data: {
        campaignMutationFrozen: true,
        campaignPreflightRevision: null,
        campaignPreflightAt: null,
        campaignFreezeActor: session.user.id,
        campaignFreezeAt: input.now,
        campaignRollbackId: input.rollbackId,
      },
    });
    return {
      revision: await advanceRevision(tx, revision),
      campaigns: await readBasisDependentCampaigns(tx, input.now),
    };
  });
}
export async function preflightListPriceRollback(
  input: Readonly<{
    client: PrismaClient;
    session: AdminSessionCandidate;
    rollbackId: string;
    now: Date;
    allInstancesVerified: boolean;
    env?: Readonly<Record<string, string | undefined>>;
  }>,
) {
  requireAdminSession(input.session);
  if (
    !input.allInstancesVerified ||
    (input.env ?? process.env).LA_PROMOTION_ACTIVATION_ENABLED !== "false"
  )
    throw new Error(
      "Verify every web/worker instance and disable activation before preflight",
    );
  return input.client.$transaction(async (tx) => {
    const revision = await lockRevision(tx);
    const row = await tx.promotionPricingRevision.findUniqueOrThrow({
      where: { id: PROMOTION_REVISION_ID },
    });
    if (
      !row.campaignMutationFrozen ||
      row.campaignRollbackId !== input.rollbackId
    )
      throw new Error("Rollback freeze is not owned");
    const campaigns = await readBasisDependentCampaigns(tx, input.now);
    if (campaigns.length)
      return {
        ok: false as const,
        reason: "BASIS_DEPENDENT_CAMPAIGNS" as const,
        revision,
        campaignIds: campaigns.slice(0, 50).map((c) => c.id),
        count: campaigns.length,
      };
    await tx.promotionPricingRevision.update({
      where: { id: PROMOTION_REVISION_ID },
      data: {
        campaignPreflightRevision: revision,
        campaignPreflightAt: input.now,
      },
    });
    return { ok: true as const, revision, rollbackId: input.rollbackId };
  });
}
export async function releaseListPriceCampaignFreeze(
  input: Readonly<{
    client: PrismaClient;
    session: AdminSessionCandidate;
    rollbackId: string;
    now: Date;
    allInstancesVerified: boolean;
    env?: NodeJS.ProcessEnv;
  }>,
) {
  requireAdminSession(input.session);
  const env = input.env ?? process.env;
  if (
    !input.allInstancesVerified ||
    readListPriceConfig(env).campaignBasis ||
    env.LA_PROMOTION_ACTIVATION_ENABLED !== "false"
  )
    throw new Error(
      "All instances must have basis OFF and activation disabled",
    );
  return input.client.$transaction(async (tx) => {
    const revision = await lockRevision(tx);
    const row = await tx.promotionPricingRevision.findUniqueOrThrow({
      where: { id: PROMOTION_REVISION_ID },
    });
    if (
      !row.campaignMutationFrozen ||
      row.campaignRollbackId !== input.rollbackId
    )
      throw new Error("Rollback freeze is not owned");
    if (
      row.campaignPreflightRevision !== revision ||
      row.campaignPreflightAt === null
    )
      throw new Error("Fresh rollback preflight required");
    if ((await readBasisDependentCampaigns(tx, input.now)).length)
      throw new Error("Percentage campaigns still enabled");
    await tx.promotionPricingRevision.update({
      where: { id: PROMOTION_REVISION_ID },
      data: { campaignMutationFrozen: false },
    });
    return { revision: await advanceRevision(tx, revision) };
  });
}
