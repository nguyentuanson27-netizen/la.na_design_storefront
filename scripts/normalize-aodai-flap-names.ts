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

  // A product can sit in both categories; normalize it once, with every key, so the result matches
  // what catalog sync and the admin membership edit produce.
  const productsById = new Map<
    string,
    { id: string; name: string; productCode: string | null; categoryKeys: string[] }
  >();
  for (const { categoryKey, product } of memberships) {
    const entry = productsById.get(product.id) ?? { ...product, categoryKeys: [] };
    entry.categoryKeys.push(categoryKey);
    productsById.set(product.id, entry);
  }

  const updates: Array<{ id: string; oldName: string; newName: string }> = [];

  for (const product of productsById.values()) {
    const label = `[${product.categoryKeys.join(",")}] [${product.productCode ?? product.id}]`;
    const newName = normalizeCategoryProductDisplayName(product.name, product.categoryKeys);
    if (newName !== product.name) {
      updates.push({ id: product.id, oldName: product.name, newName });
      console.log(`[UPDATE] ${label} "${product.name}" -> "${newName}"`);
    } else {
      console.log(`[SKIP - Already standardized] ${label} "${product.name}"`);
    }
  }
  const changedCount = updates.length;
  const totalProducts = productsById.size;

  console.log(`\nSummary: ${changedCount} products require update (out of ${totalProducts} products).`);

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
