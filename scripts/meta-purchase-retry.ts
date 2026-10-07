/** Bounded manual replay after an outage. Does not reconcile orders or rewrite event timestamps. */
import { prisma } from "../src/db/prisma.ts";

// Standalone Node scripts do not have Next's inlined build constant. Supply the deployed Pixel ID
// explicitly; the normal app continues to read its build-time constant exclusively.
const { readMetaConversionsConfig } = await import("../src/integrations/meta/pixel-config.ts");
const { reportMetaPurchaseSafely } = await import("../src/commerce/meta-purchase-reporting.ts");

try {
  if (!readMetaConversionsConfig()) throw new Error("Configure the deployed LA_BUILD_FACEBOOK_PIXEL_ID and server CAPI token");
  const now = new Date();
  const orders = await prisma.orderMirror.findMany({
    where: { state: "CONFIRMED", metaPurchaseSentAt: null,
      purchaseOccurredAt: { gte: new Date(now.getTime() - 7 * 86400_000) } },
    orderBy: { purchaseOccurredAt: "asc" }, take: 20, select: { publicCode: true },
  });
  for (const order of orders) await reportMetaPurchaseSafely(prisma, order.publicCode, null, { now });
  console.info(JSON.stringify({ name: "meta_conversions.replay", scanned: orders.length }));
} finally { await prisma.$disconnect(); }
