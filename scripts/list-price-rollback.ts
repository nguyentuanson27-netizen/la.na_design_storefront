import { prisma } from "../src/db/prisma.ts";
import {
  freezeListPriceCampaignMutations,
  preflightListPriceRollback,
  releaseListPriceCampaignFreeze,
} from "../src/commerce/list-price-rollback.ts";
const [operation, rollbackId] = process.argv.slice(2);
// The CLI is an operator entrypoint, never imported by a public action. Record the operator id.
const actor = process.env.LIST_PRICE_ROLLBACK_ACTOR;
try {
  if (!actor || actor.length > 128 || !rollbackId)
    throw new Error("Operator and rollback id required");
  const input = {
    client: prisma,
    session: {
      user: { id: actor, role: "ADMIN" },
      session: { id: "operator-cli" },
    },
    rollbackId,
    now: new Date(),
    allInstancesVerified: process.argv.includes("--all-instances-verified"),
  };
  const result =
    operation === "freeze"
      ? await freezeListPriceCampaignMutations(input)
      : operation === "preflight"
        ? await preflightListPriceRollback(input)
        : operation === "release"
          ? await releaseListPriceCampaignFreeze(input)
          : null;
  if (!result) throw new Error("Expected freeze, preflight or release");
  console.log(
    JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
  if ("ok" in result && !result.ok) process.exitCode = 2;
} catch {
  console.error(
    "List-price rollback refused; verify runbook, freeze ownership and instance configuration",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
