import { prisma } from "../src/db/prisma.ts";
import { auditListPrices } from "../src/commerce/list-price-audit.ts";
import { readPancakeShopId } from "../src/integrations/pancake/config.ts";
try {
  const summary = await auditListPrices({
    client: prisma,
    shopId: readPancakeShopId(),
    now: new Date(),
    force: true,
  });
  if (
    summary &&
    (summary.outliers || summary.invalidPos || summary.unavailableList)
  )
    process.exitCode = 2;
} catch {
  console.error("List-price rollout audit failed");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
