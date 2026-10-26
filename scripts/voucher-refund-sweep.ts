/**
 * `pnpm voucher:refund:sweep` settles voucher redemptions of REJECTED orders whose refund a crash or a lost hook left
 * undone (ADR 0018 D-4, V14). Idempotent and safe on any schedule; it only refunds an order the local state machine
 * already closed as REJECTED, and never reads the voucher feature flag (settle paths ignore it). Output is fixed text.
 */
async function main(): Promise<void> {
  const [{ createVoucherRedemptionService }, { prisma }] = await Promise.all([
    import("../src/commerce/voucher-redemption-service.ts"),
    import("../src/db/prisma.ts"),
  ]);
  try {
    const { scanned, refunded } = await createVoucherRedemptionService(prisma).sweepRejectedOrders();
    console.log(`voucher refund sweep: ${scanned} rejected orders checked, ${refunded} redemptions refunded`);
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
