/**
 * `pnpm pancake:secondary:teardown` removes every secondary-shop stock row from the mirror, records
 * that no secondary shop is configured, and observes the affected variants' availability again. It
 * needs the database only (and PANCAKE_SHOP_ID to know which catalog is meant), never the network.
 *
 * `deploy/vps/rollback.sh` runs it, with the release being left, after quiescing the writers and
 * before the previous release serves: that release adds up EVERY warehouse row it finds and does not
 * know the `secondary:*` rows, so they would count as primary stock until its own sync removed them.
 * Idempotent. Output is fixed text only.
 */
export {};

async function main(): Promise<void> {
  const [{ readPancakeShopId }, { configureSecondaryShop }, { prisma }] = await Promise.all([
    import("../src/integrations/pancake/config.ts"),
    import("../src/commerce/secondary-inventory-sync.ts"),
    import("../src/db/prisma.ts"),
  ]);
  try {
    const primaryShopId = readPancakeShopId(process.env);
    const { removed } = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId: null });
    console.log(`secondary stock removed: ${removed} warehouse rows`);
  } catch {
    console.error("secondary stock teardown failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("secondary stock teardown could not start; check DATABASE_URL and PANCAKE_SHOP_ID");
  process.exitCode = 1;
});
