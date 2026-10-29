import { prisma } from "../src/db/prisma.ts";
import { readBasisDependentCampaigns } from "../src/commerce/list-price-rollback.ts";

try {
  const campaigns = await prisma.$transaction((tx) =>
    readBasisDependentCampaigns(tx, new Date()),
  );
  console.log(
    JSON.stringify({
      name: "list_price.basis_preflight",
      count: campaigns.length,
      campaignIds: campaigns.slice(0, 50).map((campaign) => campaign.id),
    }),
  );
  if (campaigns.length) process.exitCode = 2;
} catch {
  console.error("List-price campaign preflight unavailable");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
