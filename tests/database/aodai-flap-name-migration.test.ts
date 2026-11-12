import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import pg from "pg";

import { normalizeCategoryProductDisplayName } from "../../src/commerce/product-display-name.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const MIGRATION = readFileSync(
  new URL(
    "../../prisma/migrations/20261112110000_normalize_aodai_flap_product_names/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

type Fixture = { name: string; productCode: string | null; categoryKeys: string[] };

/**
 * Each row is the state the migration finds on deploy: `name` is the Pancake-derived name and
 * `sourceName` is still null. The expectation is the TypeScript normalizer itself, so the SQL port
 * cannot drift from what catalog sync and the admin membership edit produce.
 */
const FIXTURES: Fixture[] = [
  { name: "Áo dài Bạch Hoa Vi", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo Dài Liên Châu", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài 4 tà Bạch Hoa Vi SD5002", productCode: "SD5002", categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài Kim Tuyết Mai (SD5002)", productCode: "SD5002", categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài Kim Tuyết Mai [SD5002]", productCode: "SD5002", categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài Kim Tuyết Mai - SD5002", productCode: "SD5002", categoryKeys: ["aoDai6Ta"] },
  { name: "Áo dài Ngọc Thanh Liên SV-12.b", productCode: "SV-12.b", categoryKeys: ["aoDai6Ta"] },
  { name: "Set Áo dài Khuynh Sắc", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài 4 tà", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài SD5002", productCode: "SD5002", categoryKeys: ["aoDai4Ta"] },
  { name: "Set váy SV771", productCode: "SV771", categoryKeys: ["aoDai4Ta"] },
  { name: "ÁO DÀI DAO PHỤNG", productCode: null, categoryKeys: ["aoDai6Ta"] },
  { name: "Áo dài 4 tà Hai Nhóm", productCode: null, categoryKeys: ["aoDai6Ta", "aoDai4Ta"] },
  { name: "Áo dài Hai Nhóm", productCode: null, categoryKeys: ["aoDai6Ta", "aoDai4Ta"] },
  { name: "4 tà Dao Phụng", productCode: null, categoryKeys: ["aoDai6Ta"] },
  { name: "Áo dàinhẹ", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài Hoa 2026", productCode: null, categoryKeys: ["aoDai4Ta"] },
  { name: "Áo dài Tết SD1", productCode: "SD1", categoryKeys: ["aoDai4Ta", "aoDaiTet"] },
  // Outside the flap categories nothing is touched.
  { name: "Áo dài Tết 2026", productCode: null, categoryKeys: ["aoDaiTet"] },
  { name: "Áo dài Bạch Hoa Vi", productCode: null, categoryKeys: [] },
];

async function readRows(client: pg.Client) {
  const { rows } = await client.query<{
    id: string;
    name: string;
    sourceName: string | null;
    slug: string;
    productCode: string | null;
  }>(
    `SELECT id, name, "sourceName", slug, "productCode" FROM "ProductMirror"
     WHERE "pancakeProductId" LIKE 'flap-migration-%' ORDER BY id`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

test("the flap name migration matches normalizeCategoryProductDisplayName on realistic rows", async () => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Everything happens in one rolled-back transaction: the migration also scans the rest of the
    // database, and this test must not leave a trace in (or depend on) whatever else is there.
    await client.query("BEGIN");
    for (const [index, fixture] of FIXTURES.entries()) {
      const id = `flap-migration-${String(index).padStart(2, "0")}`;
      await client.query(
        `INSERT INTO "ProductMirror" (id, "pancakeProductId", slug, name, "productCode", "syncedAt", "updatedAt")
         VALUES ($1, $1, $1, $2, $3, now(), now())`,
        [id, fixture.name, fixture.productCode],
      );
      for (const categoryKey of fixture.categoryKeys) {
        await client.query(
          `INSERT INTO "ProductCategoryMembership" ("productId", "categoryKey") VALUES ($1, $2)`,
          [id, categoryKey],
        );
      }
    }

    await client.query(MIGRATION);
    const migrated = await readRows(client);
    assert.equal(migrated.size, FIXTURES.length);

    for (const [index, fixture] of FIXTURES.entries()) {
      const id = `flap-migration-${String(index).padStart(2, "0")}`;
      const row = migrated.get(id)!;
      const inFlap = fixture.categoryKeys.some((key) => key === "aoDai4Ta" || key === "aoDai6Ta");
      const expected = inFlap
        ? normalizeCategoryProductDisplayName(fixture.name, fixture.categoryKeys)
        : fixture.name;
      assert.equal(row.name, expected, `name for ${JSON.stringify(fixture)}`);
      assert.equal(row.sourceName, inFlap ? fixture.name : null, `sourceName for ${fixture.name}`);
      assert.equal(row.slug, id, "slug is never rewritten");
      assert.equal(row.productCode, fixture.productCode, "productCode is never rewritten");
      assert.equal(row.name, row.name.trim(), `no stray whitespace in ${JSON.stringify(row.name)}`);
    }

    // Idempotent: a second run changes nothing.
    await client.query(MIGRATION);
    const again = await readRows(client);
    for (const [id, row] of migrated) assert.deepEqual(again.get(id), row);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
