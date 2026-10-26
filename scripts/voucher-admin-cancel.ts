/**
 * `pnpm voucher:refund:admin-cancel -- --order <public code or id> --evidence "<who cancelled it, where, why>" [--apply]`
 *
 * Returns the vouchers of ONE order that a person cancelled by hand (ADMIN_CANCEL, ADR 0018 D-4). Dry-run unless `--apply`.
 * Not money: orders are cash on delivery. Once-only and safe to repeat; the evidence is stored with the refund. Run it only
 * after the order is cancelled in Pancake. Fixed output: no customer data, no key.
 */
async function main(): Promise<void> {
  const [{ adminCancelVoucherOrder, parseAdminCancelArgs }, { prisma }] = await Promise.all([
    import("../src/commerce/voucher-admin-cancel.ts"),
    import("../src/db/prisma.ts"),
  ]);
  const args = parseAdminCancelArgs(process.argv.slice(2).filter((value) => value !== "--"));
  if (args === null) {
    console.error('usage: pnpm voucher:refund:admin-cancel -- --order <public code or id> --evidence "<who cancelled it, where, why; 10-400 chars>" [--apply]');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await adminCancelVoucherOrder(prisma, args);
    if (!result.ok) {
      console.error(`voucher admin cancel refused: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    for (const row of result.redemptions) console.log(`  ${row.kind} ${row.amountVnd}đ ${row.alreadyRefunded ? "already refunded" : "in use"}`);
    console.log(result.applied ? `voucher admin cancel: ${result.refunded} redemptions refunded for order ${result.orderId}` : "dry run: nothing changed (add --apply to refund)");
  } catch {
    console.error("voucher admin cancel failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("voucher admin cancel could not start; check DATABASE_URL");
  process.exitCode = 1;
});

export {};
