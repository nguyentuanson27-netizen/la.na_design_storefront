import { prisma } from "../src/db/prisma.ts";
import { normalizeCategoryProductDisplayName } from "../src/commerce/product-display-name.ts";

/**
 * Normalizes product names for 4-panel (aoDai4Ta) and 6-panel (aoDai6Ta) categories.
 *
 * Usage:
 *   node --experimental-strip-types scripts/normalize-aodai-flap-names.ts          # Dry-run preview
 *   node --experimental-strip-types scripts/normalize-aodai-flap-names.ts --apply  # Commit changes to database
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  console.log(`Starting Ao Dai flap product name normalization (mode: ${apply ? "APPLY" : "DRY-RUN"})...`);

  const memberships = await prisma.productCategoryMembership.findMany({
    where: {
      categoryKey: { in: ["aoDai4Ta", "aoDai6Ta"] },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          productCode: true,
          slug: true,
        },
      },
    },
    orderBy: [
      { categoryKey: "asc" },
      { product: { name: "asc" } },
    ],
  });

  console.log(`Found ${memberships.length} category memberships in aoDai4Ta / aoDai6Ta.`);

  let changedCount = 0;
  const updates: Array<{ id: string; oldName: string; newName: string; categoryKey: string; productCode: string | null }> = [];

  for (const { categoryKey, product } of memberships) {
    const newName = normalizeCategoryProductDisplayName(product.name, [categoryKey]);
    if (newName !== product.name) {
      changedCount++;
      updates.push({
        id: product.id,
        oldName: product.name,
        newName,
        categoryKey,
        productCode: product.productCode,
      });
      console.log(`[UPDATE] [${categoryKey}] [${product.productCode ?? product.id}] "${product.name}" -> "${newName}"`);
    } else {
      console.log(`[SKIP - Already standardized] [${categoryKey}] [${product.productCode ?? product.id}] "${product.name}"`);
    }
  }

  console.log(`\nSummary: ${changedCount} products require update (out of ${memberships.length} total).`);

  if (!apply) {
    console.log(`Dry-run complete. Run with --apply to commit these updates to the database.`);
    return;
  }

  if (updates.length > 0) {
    console.log(`Applying updates in transaction...`);
    await prisma.$transaction(
      updates.map((item) =>
        prisma.productMirror.update({
          where: { id: item.id },
          data: { name: item.newName },
        }),
      ),
    );
    console.log(`Successfully updated ${updates.length} products.`);
  }
}

main()
  .catch((err) => {
    console.error("Failed to normalize product names:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
