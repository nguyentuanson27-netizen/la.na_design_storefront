/**
 * `pnpm capacity:handoff:reconcile` records every capacity mirror handoff the current mirror already
 * proves (ADR 0014 §4.3). `deploy/vps/deploy.sh` runs it after migrating and before any new writer
 * or Caddy starts, so a roll-forward over rows written by an older release never serves with a
 * retired hold counting again. Idempotent. Output is fixed text only.
 */
async function main(): Promise<void> {
  const [{ reconcileMirrorHandoffs }, { prisma }] = await Promise.all([
    import("../src/commerce/capacity-handoff.ts"),
    import("../src/db/prisma.ts"),
  ]);
  try {
    const handedOff = await reconcileMirrorHandoffs(prisma);
    console.log(`capacity handoff reconciled: ${handedOff} holds handed to the mirror`);
  } catch {
    console.error("capacity handoff reconciliation failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("capacity handoff reconciliation could not start; check DATABASE_URL");
  process.exitCode = 1;
});
