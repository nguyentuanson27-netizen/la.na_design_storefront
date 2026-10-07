/** Bounded manual replay after an outage. Does not reconcile orders or rewrite event timestamps. */
import { prisma } from "../src/db/prisma.ts";

// Standalone Node scripts do not have Next's inlined build constant. Supply the deployed Pixel ID
// explicitly; the normal app continues to read its build-time constant exclusively.
const { readMetaConversionsConfig } = await import("../src/integrations/meta/pixel-config.ts");
const { reportMetaPurchaseSafely, cleanupMetaPurchaseAttributionSafely, META_PURCHASE_REPLAY_MS } = await import("../src/commerce/meta-purchase-reporting.ts");

try {
  const now = new Date();
  await cleanupMetaPurchaseAttributionSafely(prisma, now);
  if (!readMetaConversionsConfig()) throw new Error("Configure the deployed LA_BUILD_FACEBOOK_PIXEL_ID and server CAPI token");
  const orders = await prisma.orderMirror.findMany({
    where: { state: "CONFIRMED", metaPurchaseSentAt: null,
      purchaseOccurredAt: { gt: new Date(now.getTime() - META_PURCHASE_REPLAY_MS) } },
    orderBy: { purchaseOccurredAt: "asc" }, take: 20, select: { publicCode: true },
  });
  for (const order of orders) await reportMetaPurchaseSafely(prisma, order.publicCode, null, { now });
  console.info(JSON.stringify({ name: "meta_conversions.replay", scanned: orders.length }));
} finally { await prisma.$disconnect(); }
