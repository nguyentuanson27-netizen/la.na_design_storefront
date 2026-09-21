import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { MerchandisingError } from "../../src/commerce/merchandising-input.ts";
import { CategoryMembershipError } from "../../src/commerce/category-taxonomy.ts";
import {
  CATEGORY_READ_ISOLATION_LEVEL,
  createMerchandisingRepository,
  readRankedCategoryBucket,
  readUnrankedCategoryBucket,
} from "../../src/commerce/merchandising-repository.ts";
import { listRelatedStorefrontProducts } from "../../src/commerce/storefront-related-products.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createMerchandisingRepository(prisma);

const testShopId = 920_070;
const otherShopId = 920_071;
const externalPrefix = "merchandising-";

/**
 * The one table here that does not cascade from a seeded product.
 *
 * `CategoryEditorialMedia` is keyed by bare `categoryKey` with no foreign key, and three tests
 * need it genuinely empty rather than merely free of this file's rows: the audit read is asserted
 * to return exactly one row, and two other reads are asserted to be `null`. So `cleanup()`
 * has to empty it -- and, running from both `beforeEach` and `afterEach`, it emptied whatever the
 * database already held and never put it back. Against a developer's or a staging database that is
 * every category's configured hero and mega-menu image, gone, with no way to tell from the test
 * output that it happened.
 *
 * The rows are therefore parked once before the file's first test and restored after its last, so
 * the tests still see the empty table they need while the database ends as it started.
 */
type ParkedEditorialMedia = {
  categoryKey: string;
  heroImageUrl: string | null;
  megaMenuImageUrl: string | null;
};

let parkedEditorialMedia: ParkedEditorialMedia[] = [];

async function parkEditorialMedia() {
  parkedEditorialMedia = await prisma.categoryEditorialMedia.findMany({
    select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
  });
}

async function restoreEditorialMedia() {
  await prisma.categoryEditorialMedia.deleteMany({});
  if (parkedEditorialMedia.length > 0) {
    await prisma.categoryEditorialMedia.createMany({ data: parkedEditorialMedia });
  }
  parkedEditorialMedia = [];
}

async function cleanup() {
  // Every merchandising row cascades from `ProductMirror`, so deleting the seeded products is
  // enough — which is itself the ADR §3/§5/§7 `onDelete: Cascade` behaviour under test.
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { startsWith: externalPrefix } },
  });
  // Parked by `test.before` and put back by `test.after`; see the note above.
  await prisma.categoryEditorialMedia.deleteMany({});
}

async function seed(
  key: string,
  { name = key.toUpperCase(), isActive = true, shopId = testShopId }: Partial<{
    name: string;
    isActive: boolean;
    shopId: number;
  }> = {},
): Promise<string> {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${externalPrefix}${key}`,
      slug: `${externalPrefix}${key}`,
      name,
      isActive,
      syncedAt: new Date("2026-09-17T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return created.id;
}

test.before(parkEditorialMedia);
test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await restoreEditorialMedia();
  await prisma.$disconnect();
});

test("M2 homepage Featured is a full replacement that keeps the admin's order", async () => {
  const [a, b, c] = [await seed("hp-a"), await seed("hp-b"), await seed("hp-c")];

  await repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [c, a] });
  assert.deepEqual(
    (await repository.listHomepageFeatured({ shopId: testShopId })).map((p) => p.id),
    [c, a],
  );

  // Replacement, not merge: the previous selection is gone, and the positions it occupied are free
  // for the new one. An incremental reorder would have to shuffle rows through the unique index.
  await repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [b, c] });
  assert.deepEqual(
    (await repository.listHomepageFeatured({ shopId: testShopId })).map((p) => p.id),
    [b, c],
  );

  await repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [] });
  assert.deepEqual(await repository.listHomepageFeatured({ shopId: testShopId }), []);
});

test("M2 Featured skips products that are no longer sellable", async () => {
  const visible = await seed("hp-visible");
  const withdrawn = await seed("hp-withdrawn");

  await repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [withdrawn, visible] });
  await prisma.productMirror.update({ where: { id: withdrawn }, data: { isActive: false } });

  // Master spec §20: the section shortens, it does not top itself up from newest/bestseller logic.
  assert.deepEqual(
    (await repository.listHomepageFeatured({ shopId: testShopId })).map((p) => p.id),
    [visible],
  );
});

test("M2 a rejected Featured write leaves the previous selection intact", async () => {
  const a = await seed("hp-keep");
  const foreign = await seed("hp-foreign", { shopId: otherShopId });

  await repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [a] });

  await assert.rejects(
    () => repository.replaceHomepageFeatured({ shopId: testShopId, productIds: [foreign] }),
    (error: unknown) =>
      error instanceof MerchandisingError && error.reason === "merchandising-invalid-product",
  );

  // The delete and the insert are one transaction, so a refused write cannot leave the surface
  // empty. Without that, a typo would silently clear the homepage.
  assert.deepEqual(
    (await repository.listHomepageFeatured({ shopId: testShopId })).map((p) => p.id),
    [a],
  );
});

test("G4 membership is replaced transactionally and refuses a cross-tree selection", async () => {
  const product = await seed("mem-a");

  await repository.replaceCategoryMembership({
    shopId: testShopId,
    productId: product,
    categoryKeys: ["aoDaiTet", "aoDaiCuoi"],
  });
  assert.deepEqual([...(await repository.readCategoryMembership(product))].sort(), [
    "aoDaiCuoi",
    "aoDaiTet",
  ]);

  await assert.rejects(
    () =>
      repository.replaceCategoryMembership({
        shopId: testShopId,
        productId: product,
        categoryKeys: ["aoDaiTet", "setVay"],
      }),
    (error: unknown) =>
      error instanceof CategoryMembershipError &&
      error.reason === "category-membership-multiple-top-level",
  );

  // This transaction is the only place the one-top-level invariant is enforced, so a refusal must
  // not half-apply: the product keeps exactly the assignment it had.
  assert.deepEqual([...(await repository.readCategoryMembership(product))].sort(), [
    "aoDaiCuoi",
    "aoDaiTet",
  ]);

  await repository.replaceCategoryMembership({
    shopId: testShopId,
    productId: product,
    categoryKeys: [],
  });
  assert.deepEqual(await repository.readCategoryMembership(product), []);
});

test("M3b a parent PLP lists and ranks the union of its subcategories", async () => {
  const tet = await seed("plp-tet", { name: "ZZZ Tet" });
  const cuoi = await seed("plp-cuoi", { name: "AAA Cuoi" });
  const parentOnly = await seed("plp-parent", { name: "MMM Parent" });

  await repository.replaceCategoryMembership({ shopId: testShopId, productId: tet, categoryKeys: ["aoDaiTet"] });
  await repository.replaceCategoryMembership({ shopId: testShopId, productId: cuoi, categoryKeys: ["aoDaiCuoi"] });
  await repository.replaceCategoryMembership({ shopId: testShopId, productId: parentOnly, categoryKeys: ["aoDai"] });

  // Unranked: name ascending, then id.
  assert.deepEqual(
    (await repository.listCategoryProducts({ shopId: testShopId, categoryKey: "aoDai", limit: 10 })).map(
      (p) => p.name,
    ),
    ["AAA Cuoi", "MMM Parent", "ZZZ Tet"],
  );

  // A product assigned only to a subcategory has no membership row for `aoDai`, yet the parent PLP
  // must still be able to rank it — which is why order is keyed by categoryKey, not by membership.
  await repository.replaceCategoryProductOrder({
    shopId: testShopId,
    input: { categoryKey: "aoDai", productIds: [tet, parentOnly] },
  });

  assert.deepEqual(
    (await repository.listCategoryProducts({ shopId: testShopId, categoryKey: "aoDai", limit: 10 })).map(
      (p) => p.name,
    ),
    ["ZZZ Tet", "MMM Parent", "AAA Cuoi"],
  );

  // The subcategory page is unaffected by the parent's ranking: they are separate categoryKeys.
  assert.deepEqual(
    (await repository.listCategoryProducts({ shopId: testShopId, categoryKey: "aoDaiCuoi", limit: 10 })).map(
      (p) => p.name,
    ),
    ["AAA Cuoi"],
  );
});

test("M3b a ranking may only contain products the category actually lists", async () => {
  const listed = await seed("rank-listed");
  const elsewhere = await seed("rank-elsewhere");

  await repository.replaceCategoryMembership({ shopId: testShopId, productId: listed, categoryKeys: ["aoDaiTet"] });
  await repository.replaceCategoryMembership({ shopId: testShopId, productId: elsewhere, categoryKeys: ["setVay"] });

  await assert.rejects(
    () =>
      repository.replaceCategoryProductOrder({
        shopId: testShopId,
        input: { categoryKey: "aoDai", productIds: [listed, elsewhere] },
      }),
    (error: unknown) =>
      error instanceof MerchandisingError && error.reason === "merchandising-invalid-product",
  );

  assert.deepEqual(
    await repository.listCategoryProductOrderForAudit(100),
    [],
    "a refused ranking must write nothing",
  );
});

test("M3a related overrides are stored in admin order and cascade with the product", async () => {
  const source = await seed("rel-source");
  const first = await seed("rel-first");
  const second = await seed("rel-second");

  await repository.replaceRelatedProductOverrides({
    shopId: testShopId,
    input: { productId: source, relatedProductIds: [second, first] },
  });

  assert.deepEqual(
    (await repository.listRelatedProductOverrides({ shopId: testShopId, productId: source })).map(
      (p) => p.id,
    ),
    [second, first],
  );

  // `onDelete: Cascade` on the *target* side: a deleted product stops being anyone's related pick
  // rather than leaving a dangling row.
  await prisma.productMirror.delete({ where: { id: second } });
  assert.deepEqual(
    (await repository.listRelatedProductOverrides({ shopId: testShopId, productId: source })).map(
      (p) => p.id,
    ),
    [first],
  );
});

test("M3a the database refuses a self-referencing override even when the parser is bypassed", async () => {
  const product = await seed("rel-self");

  // The admin boundary already refuses this. The CHECK is defence in depth for the writers that do
  // not go through it — a fixture, a repair query — and it is enforceable precisely because the
  // predicate is intra-row, unlike top-level exclusivity.
  await assert.rejects(() =>
    prisma.relatedProductOverride.create({
      data: { productId: product, relatedProductId: product, position: 0 },
    }),
  );
});

test("M3a a negative position is refused by the database on every ordered surface", async () => {
  const product = await seed("pos-guard");
  const other = await seed("pos-guard-other");

  await assert.rejects(() =>
    prisma.homepageFeaturedProduct.create({ data: { productId: product, position: -1 } }),
  );
  await assert.rejects(() =>
    prisma.categoryProductOrder.create({
      data: { categoryKey: "aoDai", productId: product, position: -1 },
    }),
  );
  await assert.rejects(() =>
    prisma.relatedProductOverride.create({
      data: { productId: product, relatedProductId: other, position: -1 },
    }),
  );
});

test("M2 category editorial media keeps hero and mega-menu independent", async () => {
  const hero = "https://content.pancake.vn/catalog/1/2/3/hero.jpg";
  const mega = "https://content.pancake.vn/catalog/1/2/3/mega.png";

  await repository.saveCategoryEditorialMedia({
    categoryKey: "aoDai",
    heroImageUrl: hero,
    megaMenuImageUrl: mega,
  });

  assert.deepEqual(await repository.readCategoryEditorialMedia("aoDai"), {
    categoryKey: "aoDai",
    heroImageUrl: hero,
    megaMenuImageUrl: mega,
  });

  // Clearing one leaves the other alone: ADR §6 treats them as two surfaces, not one asset reused.
  await repository.saveCategoryEditorialMedia({
    categoryKey: "aoDai",
    heroImageUrl: null,
    megaMenuImageUrl: mega,
  });
  const cleared = await repository.readCategoryEditorialMedia("aoDai");
  assert.equal(cleared?.heroImageUrl, null);
  assert.equal(cleared?.megaMenuImageUrl, mega);

  // Absence is the answer for a category nobody has given media, not a fabricated asset.
  assert.equal(await repository.readCategoryEditorialMedia("phuKien"), null);
});

test("M2 an untrusted media host is refused and nothing is written", async () => {
  await assert.rejects(
    () =>
      repository.saveCategoryEditorialMedia({
        categoryKey: "setDo",
        heroImageUrl: "https://evil.example.com/a.jpg",
      }),
    (error: unknown) =>
      error instanceof MerchandisingError && error.reason === "merchandising-invalid-media-url",
  );

  assert.equal(await repository.readCategoryEditorialMedia("setDo"), null);
});

test("G4 the audit reads see every category-keyed owner", async () => {
  const product = await seed("audit-a");
  await repository.replaceCategoryMembership({ shopId: testShopId, productId: product, categoryKeys: ["aoDaiTet"] });
  await repository.replaceCategoryProductOrder({
    shopId: testShopId,
    input: { categoryKey: "aoDaiTet", productIds: [product] },
  });
  await repository.saveCategoryEditorialMedia({ categoryKey: "aoDaiTet" });

  // ADR §4.8's pre-activation gate needs all three owners, not just membership: order and media
  // carry the same bare `categoryKey` with no foreign key and have no invariant of their own to
  // make a retired key visible.
  assert.deepEqual(await repository.listCategoryMembershipsForAudit(100), [
    { productId: product, categoryKey: "aoDaiTet" },
  ]);
  assert.deepEqual(await repository.listCategoryProductOrderForAudit(100), [
    { categoryKey: "aoDaiTet", productId: product },
  ]);
  assert.deepEqual(await repository.listCategoryEditorialMediaForAudit(100), [
    { categoryKey: "aoDaiTet" },
  ]);
});

test("M3a a ranked winner outside the product-id sample is still selected", async () => {
  // Review 5709811796. The previous shape took `limit` rows ordered by `productId` and only then
  // applied the §7 order, so a merchandised product whose id sorted past the sample was
  // unreachable — the bound silently changed the answer instead of just capping it.
  //
  // The fixture constructs that exact case: seed more products than the per-category bound, read
  // their ids back in ascending order, and rank the LAST one. Under the old query it would never
  // have been fetched; under §7 it must come first.
  const limit = 4;
  const seeded: string[] = [];
  for (let index = 0; index < limit * 3; index += 1) {
    seeded.push(
      await seed(`sample-${index}`, { name: `Candidate ${String(index).padStart(2, "0")}` }),
    );
  }

  for (const productId of seeded) {
    await repository.replaceCategoryMembership({
      shopId: testShopId,
      productId,
      categoryKeys: ["aoDaiTet"],
    });
  }

  const byIdAscending = [...seeded].sort((left, right) => left.localeCompare(right));
  const winner = byIdAscending[byIdAscending.length - 1];
  assert.ok(
    byIdAscending.slice(0, limit).every((id) => id !== winner),
    "the fixture must place the winner outside the first `limit` product ids",
  );

  await repository.replaceCategoryProductOrder({
    shopId: testShopId,
    input: { categoryKey: "aoDaiTet", productIds: [winner] },
  });

  const candidates = await repository.listCategoryRelatedCandidates({
    shopId: testShopId,
    categoryKey: "aoDaiTet",
    limit,
  });

  const ranked = candidates.filter((candidate) => candidate.position !== null);
  assert.deepEqual(
    ranked.map((candidate) => candidate.product.id),
    [winner],
    "the ranked product must be in the bounded candidate set",
  );

  // And end to end through the §7 resolver, which is what actually decides the order.
  const related = await listRelatedStorefrontProducts({
    currentProduct: { id: seeded[0], categoryKeys: ["aoDaiTet"] },
    loadManualOverrides: async () => [],
    loadCategoryCandidates: async (categoryKey) =>
      repository.listCategoryRelatedCandidates({ shopId: testShopId, categoryKey, limit }),
    limit,
  });

  assert.equal(related[0]?.id, winner, "the merchandised rank must lead the related list");
});

test("M3b a ranked winner outside the name-ordered page still leads the PLP", async () => {
  // The PLP read was never truncated before ordering, so this does not reproduce the reviewed bug —
  // it guards the bound newly introduced alongside the fix, which is where the same mistake would
  // reappear. The ranked product is named last on purpose, so name ordering alone would push it off
  // the first page.
  const limit = 3;
  const ids: string[] = [];
  for (let index = 0; index < limit * 3; index += 1) {
    ids.push(await seed(`plp-bound-${index}`, { name: `Item ${String(index).padStart(2, "0")}` }));
  }
  const lastByName = ids[ids.length - 1];

  for (const productId of ids) {
    await repository.replaceCategoryMembership({
      shopId: testShopId,
      productId,
      categoryKeys: ["aoDaiTet"],
    });
  }
  await repository.replaceCategoryProductOrder({
    shopId: testShopId,
    input: { categoryKey: "aoDaiTet", productIds: [lastByName] },
  });

  const page = await repository.listCategoryProducts({
    shopId: testShopId,
    categoryKey: "aoDaiTet",
    limit,
  });

  assert.equal(page.length, limit);
  assert.equal(page[0]?.id, lastByName, "the merchandised rank must lead the page");
  // The rest is the unranked tail by name, and the ranked product is not repeated.
  assert.deepEqual(
    page.slice(1).map((product) => product.name),
    ["Item 00", "Item 01"],
  );
});

/**
 * Runs the two bucket reads with a ranking replacement committed **between** them, from a second
 * connection, and reports how many times the product came back.
 *
 * This is the interleaving review 5232098227 described, and it is *forced* rather than raced: the
 * write commits while the read transaction is suspended between bucket 1 and bucket 2, so the
 * outcome is deterministic at each isolation level instead of depending on timing. It drives the
 * shipped bucket reads rather than copies of them.
 */
async function readWithRankingReplacedBetweenBuckets(
  isolationLevel: "ReadCommitted" | "RepeatableRead",
  { categoryKey, productId, limit }: { categoryKey: string; productId: string; limit: number },
) {
  const other = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    return await prisma.$transaction(
      async (tx) => {
        const args = {
          shopId: testShopId,
          rankCategoryKey: categoryKey,
          membershipKeys: [categoryKey],
          limit,
        };

        const ranked = await readRankedCategoryBucket(tx, args);

        // A fully transactional ranking replacement commits between the two buckets.
        await other.categoryProductOrder.deleteMany({ where: { categoryKey } });

        const unranked = await readUnrankedCategoryBucket(tx, args);

        const merged = [...ranked, ...unranked];
        return {
          sawRankInBucketOne: ranked.some((row) => row.product.id === productId),
          occurrences: merged.filter((row) => row.product.id === productId).length,
        };
      },
      { isolationLevel },
    );
  } finally {
    await other.$disconnect();
  }
}

test("M3b the two bucket reads share one snapshot across a concurrent ranking replacement", async () => {
  // Review 5232098227. The buckets are complementary only while both statements observe the same
  // committed ranking state. Under READ COMMITTED each statement takes a fresh snapshot, so a
  // replacement landing in between makes one product ranked to bucket 1 and unranked to bucket 2.
  const product = await seed("snapshot-a", { name: "Snapshot Candidate" });
  await repository.replaceCategoryMembership({
    shopId: testShopId,
    productId: product,
    categoryKeys: ["aoDaiTet"],
  });

  const rank = async () =>
    repository.replaceCategoryProductOrder({
      shopId: testShopId,
      input: { categoryKey: "aoDaiTet", productIds: [product] },
    });

  await rank();
  const repeatableRead = await readWithRankingReplacedBetweenBuckets(CATEGORY_READ_ISOLATION_LEVEL, {
    categoryKey: "aoDaiTet",
    productId: product,
    limit: 4,
  });

  assert.equal(repeatableRead.sawRankInBucketOne, true, "the fixture must start with the rank in place");
  assert.equal(
    repeatableRead.occurrences,
    1,
    "under one snapshot the product appears exactly once — never duplicated, never dropped",
  );

  // The anomaly this guards against, shown to be real rather than hypothetical: at PostgreSQL's
  // default level the same forced interleaving double-counts the product.
  await rank();
  const readCommitted = await readWithRankingReplacedBetweenBuckets("ReadCommitted", {
    categoryKey: "aoDaiTet",
    productId: product,
    limit: 4,
  });

  assert.equal(readCommitted.sawRankInBucketOne, true);
  assert.equal(
    readCommitted.occurrences,
    2,
    "READ COMMITTED must be shown to break the complementary-bucket assumption",
  );
});
