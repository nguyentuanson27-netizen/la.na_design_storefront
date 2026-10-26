/**
 * `pnpm voucher:refund:sweep` settles voucher redemptions of REJECTED orders and of orders Pancake cancelled (a stored,
 * complete, shop-verified status 7) whose refund a crash or a lost hook left undone (ADR 0018 D-4, V14). Idempotent and safe on any schedule; it only refunds a signal `refundOrder` re-verifies under the order
 * lock (local REJECTED, or the stored cancelled status on a complete shop-verified record), and never reads the voucher feature flag (settle paths ignore it). Output is fixed text.
 */
async function main(): Promise<void> {
  const [{ createVoucherRedemptionService }, { prisma }] = await Promise.all([
    import("../src/commerce/voucher-redemption-service.ts"),
    import("../src/db/prisma.ts"),
  ]);
  try {
    const { rejected, cancelled } = await createVoucherRedemptionService(prisma).sweep();
    console.log(`voucher refund sweep: ${rejected.scanned} rejected orders checked, ${rejected.refunded} redemptions refunded; ${cancelled.scanned} cancelled orders checked, ${cancelled.refunded} redemptions refunded`);
  } catch {
    console.error("voucher refund sweep failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("voucher refund sweep could not start; check DATABASE_URL");
  process.exitCode = 1;
});

export {};
